import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import sharp from 'sharp';
import AdmZip from 'adm-zip';
import { makeFileTools } from './file-tools.js';
import { getBuiltInToolKey, getBuiltInNamespace, hydrateBuiltInTools } from '../built-in-tools.js';
import { closeDb } from '../../../db/database.js';
import { addFileAccessRoot, listFileAccessRoots, preflightFileToolAccess, removeFileAccessRoot } from './file-access-policy.js';
import { getEventBus } from '../../telemetry/event-bus.js';
import { AgentExecutor } from '../../agent/agent-executor.js';
import type { LLMGateway } from '../../gateway/gateway.js';
import type { ToolCall } from '../../gateway/providers/base.provider.js';
import { validateToolArguments } from '../tool-argument-validator.js';

let sandbox: string;
let root: string;
let outside: string;
let previousDataDir: string | undefined;

async function call(name: string, params: unknown) {
    const tool = makeFileTools().find(candidate => candidate.name === name);
    if (!tool) throw new Error(`Missing tool ${name}`);
    return tool.execute(params);
}

beforeEach(async () => {
    previousDataDir = process.env.CYNOSURE_DATA_DIR;
    sandbox = await fs.mkdtemp(path.join(tmpdir(), 'cynosure-native-files-'));
    process.env.CYNOSURE_DATA_DIR = path.join(sandbox, 'data');
    root = path.join(sandbox, 'allowed');
    outside = path.join(sandbox, 'outside');
    await fs.mkdir(root);
    await fs.mkdir(outside);
    for (const allowed of listFileAccessRoots()) removeFileAccessRoot(allowed);
    await addFileAccessRoot(root);
});

afterEach(async () => {
    closeDb();
    if (previousDataDir === undefined) delete process.env.CYNOSURE_DATA_DIR;
    else process.env.CYNOSURE_DATA_DIR = previousDataDir;
    await fs.rm(sandbox, { recursive: true, force: true });
});

describe('native file tools', () => {
    it('publishes schemas accepted by the agent tool validator', () => {
        const examples: Record<string, unknown> = {
            file_info: {},
            file_list_directory: { path: root },
            file_search: { path: root, pattern: '*.txt' },
            file_read: { path: path.join(root, 'one.txt') },
            file_write: { path: path.join(root, 'one.txt'), content: 'test' },
            file_edit: { path: path.join(root, 'one.txt'), edits: [{ oldText: 'a', newText: 'b' }] },
            file_create_directory: { path: path.join(root, 'new') },
            file_move: { source: root, destination: outside },
            file_merge: { source: root, destination: outside },
            file_archive: { action: 'extract', archivePath: path.join(root, 'one.zip') },
            file_delete: { path: path.join(root, 'one.txt') },
        };
        for (const tool of makeFileTools()) {
            const validation = validateToolArguments(examples[tool.name], tool.parameters);
            expect(validation.valid, `${tool.name}: ${validation.errors.join('; ')}`).toBe(true);
        }
    });
    it('registers in the Files namespace and hydrates an executable tool', async () => {
        expect(getBuiltInNamespace('file_read').id).toBe('builtin:files');
        expect(getBuiltInToolKey('file_read')).toBe('builtin:files::file_read');
        const definition = makeFileTools().find(tool => tool.name === 'file_info')!;
        const [hydrated] = hydrateBuiltInTools([{
            ...definition,
            execute: async () => ({ success: false, output: 'stub' }),
            registryKey: getBuiltInToolKey('file_info'),
            originalName: 'file_info',
            namespaceId: 'builtin:files',
            namespaceLabel: 'Built-In: Files',
        }], { conversationId: 'test', broadcast: () => undefined });
        expect((await hydrated.execute({})).output).toContain(root);
    });

    it('writes, reads, previews edits, saves edits, searches, and lists', async () => {
        const file = path.join(root, 'notes', 'one.txt');
        expect(listFileAccessRoots()).toEqual([root]);
        const writeResult = await call('file_write', { path: file, content: 'hello world\n' });
        expect(writeResult.success, writeResult.output).toBe(true);
        expect((await call('file_read', { path: file })).output).toBe('hello world\n');
        expect((await call('file_write', { path: file, content: 'oops' })).success).toBe(false);
        const edit = { path: file, edits: [{ oldText: 'world', newText: 'Cynosure' }] };
        expect((await call('file_edit', edit)).output).toContain('Dry run only.');
        expect(await fs.readFile(file, 'utf8')).toBe('hello world\n');
        expect((await call('file_edit', { ...edit, dryRun: false })).success).toBe(true);
        expect((await call('file_search', { path: root, pattern: '*.txt' })).output).toContain(file);
        expect((await call('file_list_directory', { path: path.dirname(file) })).output).toContain('one.txt');
    });

    it('rejects paths outside roots and symlinks escaping a root', async () => {
        const target = path.join(outside, 'secret.txt');
        await fs.writeFile(target, 'secret');
        await fs.symlink(outside, path.join(root, 'escape'));
        await fs.symlink(path.join(outside, 'missing.txt'), path.join(root, 'broken'));
        expect((await call('file_read', { path: target })).success).toBe(false);
        expect((await call('file_read', { path: path.join(root, 'escape', 'secret.txt') })).success).toBe(false);
        expect((await call('file_write', { path: path.join(root, 'escape', 'new.txt'), content: 'no' })).success).toBe(false);
        expect((await call('file_write', { path: path.join(root, 'broken'), content: 'no' })).success).toBe(false);
        expect((await call('file_delete', { path: root, recursive: true })).success).toBe(false);
        expect(await fs.readFile(target, 'utf8')).toBe('secret');
    });

    it('persists allowlist changes and applies them recursively', async () => {
        expect(listFileAccessRoots()).toEqual([root]);
        expect(await addFileAccessRoot(outside)).toContain(outside);
        const nested = path.join(outside, 'deep');
        await fs.mkdir(nested);
        expect((await call('file_write', { path: path.join(nested, 'allowed.txt'), content: 'yes' })).success).toBe(true);
        expect(removeFileAccessRoot(outside)).toEqual([root]);
        expect((await call('file_read', { path: path.join(nested, 'allowed.txt') })).success).toBe(false);
    });

    it('asks before an unlisted folder is accessed and stores approval', async () => {
        const target = path.join(outside, 'prompt.txt');
        await fs.writeFile(target, 'approved');
        const unsubscribe = getEventBus().on('hitl:request', (event) => {
            const request = event as { toolCalls: Array<{ fileAccess?: { folder: string } }>; resolve: (result: { approved: boolean }) => void };
            expect(request.toolCalls[0].fileAccess?.folder).toBe(outside);
            request.resolve({ approved: true });
        });
        try {
            await preflightFileToolAccess({ toolName: 'file_read', arguments: { path: target }, conversationId: 'conversation-test' });
            const result = await call('file_read', { path: target });
            expect(result.success, result.output).toBe(true);
            expect(result.output).toBe('approved');
            expect(listFileAccessRoots()).toContain(outside);
        } finally {
            unsubscribe();
        }
    });

    it('leaves an unlisted folder blocked when the user denies the request', async () => {
        const target = path.join(outside, 'denied.txt');
        await fs.writeFile(target, 'private');
        const unsubscribe = getEventBus().on('hitl:request', (event) => {
            (event as { resolve: (result: { approved: boolean }) => void }).resolve({ approved: false });
        });
        try {
            await expect(preflightFileToolAccess({ toolName: 'file_read', arguments: { path: target }, conversationId: 'conversation-test' })).rejects.toThrow('denied by the user');
            expect((await call('file_read', { path: target })).success).toBe(false);
            expect(listFileAccessRoots()).not.toContain(outside);
        } finally {
            unsubscribe();
        }
    });

    it('waits for folder approval before starting the tool execution timeout', async () => {
        const target = path.join(outside, 'slow-approval.txt');
        await fs.writeFile(target, 'read after approval');
        const tool = { ...makeFileTools().find(candidate => candidate.name === 'file_read')!, timeout: 100,
            namespaceId: 'builtin:files', originalName: 'file_read' };
        const executor = new AgentExecutor({ gateway: {} as LLMGateway, tools: [tool], conversationId: 'test', broadcast: () => undefined });
        const unsubscribe = getEventBus().on('hitl:request', (event) => {
            setTimeout(() => (event as { resolve: (result: { approved: boolean }) => void }).resolve({ approved: true }), 150);
        });
        try {
            const call: ToolCall = { id: 'read', type: 'function', function: { name: 'file_read', arguments: JSON.stringify({ path: target }) } };
            const result = await (executor as unknown as { executeSingleToolCall: (call: ToolCall) => Promise<{ success: boolean; output: string }> }).executeSingleToolCall(call);
            expect(result.success, result.output).toBe(true);
            expect(result.output).toBe('read after approval');
        } finally {
            unsubscribe();
        }
    });

    it('creates and extracts ZIP archives without overwriting existing files', async () => {
        const source = path.join(root, 'source.txt');
        const archive = path.join(root, 'bundle.zip');
        const extracted = path.join(root, 'extracted');
        await fs.writeFile(source, 'archive content');
        expect((await call('file_archive', { action: 'create', filePaths: [source], destination: archive })).success).toBe(true);
        expect((await call('file_archive', { action: 'extract', archivePath: archive, destination: extracted })).success).toBe(true);
        expect(await fs.readFile(path.join(extracted, 'source.txt'), 'utf8')).toBe('archive content');
        expect((await call('file_archive', { action: 'extract', archivePath: archive, destination: extracted })).success).toBe(false);
    });

    it('rejects ZIP entries that try to escape the extraction directory', async () => {
        const archivePath = path.join(root, 'unsafe.zip');
        const zip = new AdmZip();
        zip.addFile('aa/escape.txt', Buffer.from('not allowed'));
        // Replace both ZIP filename records without changing their lengths.
        await fs.writeFile(archivePath, Buffer.from(zip.toBuffer().toString('binary').replaceAll('aa/escape.txt', '../escape.txt'), 'binary'));
        const extracted = path.join(root, 'extracted');
        const result = await call('file_archive', { action: 'extract', archivePath, destination: extracted });
        expect(result.success).toBe(false);
        await expect(fs.access(path.join(root, 'escape.txt'))).rejects.toThrow();
    });

    it('returns image content and vision data for thumbnail reads', async () => {
        const imagePath = path.join(root, 'image.png');
        await fs.writeFile(imagePath, await sharp({ create: { width: 16, height: 16, channels: 4, background: '#ff0000' } }).png().toBuffer());
        const result = await call('file_read', { path: imagePath, mode: 'thumbnails' });
        expect(result.success).toBe(true);
        expect(result.content?.some(block => block.type === 'image')).toBe(true);
        expect(result.imageDataUrls?.[0]).toMatch(/^data:image\/png;base64,/);
    });
});
