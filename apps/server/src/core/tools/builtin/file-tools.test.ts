import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import sharp from 'sharp';
import AdmZip from 'adm-zip';
import { makeFileTools } from './file-tools.js';
import { getBuiltInToolKey, getBuiltInNamespace, hydrateBuiltInTools } from '../built-in-tools.js';
import { closeDb, getDb } from '../../../db/database.js';
import { toFileUrl } from '../../artifacts/image-artifacts.js';
import { getAppDataDir } from '../../data-dir.js';
import { addFileAccessRoot, listFileAccessRoots, preflightFileToolAccess, removeFileAccessRoot, runInFileAccessScope } from './file-access-policy.js';
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
    // Other tests may have opened the process-wide DB before this test changes the data dir.
    closeDb();
    previousDataDir = process.env.CYNOSURE_DATA_DIR;
    sandbox = await fs.mkdtemp(path.join(tmpdir(), 'cynosure-native-files-'));
    process.env.CYNOSURE_DATA_DIR = sandbox;
    root = path.join(sandbox, 'allowed');
    outside = path.join(sandbox, 'outside');
    await fs.mkdir(root);
    await fs.mkdir(outside);
    if (getAppDataDir() !== path.join(sandbox, 'data')) throw new Error('File tool test database is not isolated.');
    for (const allowed of listFileAccessRoots()) removeFileAccessRoot(allowed);
    await addFileAccessRoot(root);
});

afterEach(async () => {
    closeDb();
    if (previousDataDir === undefined) delete process.env.CYNOSURE_DATA_DIR;
    else process.env.CYNOSURE_DATA_DIR = previousDataDir;
    await fs.rm(sandbox, { recursive: true, force: true });
});

describe('attachment_export', () => {
    async function seedImage(): Promise<string> {
        const stored = path.join(sandbox, 'stored', 'abc123.jpg');
        await fs.mkdir(path.dirname(stored), { recursive: true });
        await fs.writeFile(stored, 'jpeg-bytes');
        const db = getDb();
        db.prepare("INSERT INTO conversations (id, title, created_at, updated_at) VALUES ('c1', 'Chat', 1, 1)").run();
        db.prepare("INSERT INTO messages (id, conversation_id, role, content, content_blocks_json, created_at) VALUES ('m1', 'c1', 'user', '', ?, 1)")
            .run(JSON.stringify([{ type: 'text', text: 'save this' }, { type: 'image', artifactId: 'x', url: toFileUrl(stored) }]));
        return stored;
    }
    const exportIn = (conversationId: string, params: unknown) => runInFileAccessScope(conversationId, () => call('attachment_export', params));

    it('copies an attached image into a directory, keeping its name, and numbers duplicate names', async () => {
        const stored = await seedImage();
        const result = await exportIn('c1', { attachmentId: 'abc123.jpg', path: root });
        expect(result.success, result.output).toBe(true);
        expect(await fs.readFile(path.join(root, 'abc123.jpg'), 'utf8')).toBe('jpeg-bytes');
        expect(await fs.readFile(stored, 'utf8')).toBe('jpeg-bytes');

        const second = await exportIn('c1', { attachmentId: 'abc123.jpg', path: root });
        expect(second.output).toContain(path.join(root, 'abc123 (2).jpg'));
        expect(second.output).toContain('abc123.jpg already existed');
        expect(await fs.readFile(path.join(root, 'abc123 (2).jpg'), 'utf8')).toBe('jpeg-bytes');
        expect((await exportIn('c1', { attachmentId: 'abc123.jpg', path: path.join(root, 'recipes', 'lasagna.jpg') })).success).toBe(true);
        expect(await fs.readFile(path.join(root, 'recipes', 'lasagna.jpg'), 'utf8')).toBe('jpeg-bytes');
    });

    it('lists available attachments for an unknown id and stays inside allowed folders', async () => {
        await seedImage();
        const missing = await exportIn('c1', { attachmentId: 'nope', path: root });
        expect(missing.success).toBe(false);
        expect(missing.output).toContain('abc123.jpg (image, attachmentId: abc123.jpg)');
        expect((await exportIn('c1', { attachmentId: 'abc123.jpg', path: outside })).success).toBe(false);
        expect((await exportIn('other', { attachmentId: 'abc123.jpg', path: root })).success).toBe(false);
    });
});

describe('native file tools', () => {
    it('publishes schemas accepted by the agent tool validator', () => {
        const examples: Record<string, unknown> = {
            file_info: {},
            directory_list: { path: root },
            file_search: { path: root, pattern: '*.txt' },
            file_grep: { path: root, pattern: 'hello', glob: '*.txt' },
            file_read: { path: path.join(root, 'one.txt') },
            file_write: { path: path.join(root, 'one.txt'), content: 'test' },
            attachment_export: { attachmentId: 'photo.jpg', path: root },
            file_edit: { path: path.join(root, 'one.txt'), edits: [{ oldText: 'a', newText: 'b' }] },
            directory_create: { path: path.join(root, 'new') },
            file_move: { source: root, destination: outside },
            directory_merge: { source: root, destination: outside },
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
        for (const name of ['directory_list', 'directory_create', 'directory_merge']) {
            expect(getBuiltInToolKey(name)).toBe(`builtin:files::${name}`);
        }
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
        expect((await call('file_read', { path: file })).output).toBe('1\thello world');
        expect((await call('file_read', { path: file, lineNumbers: false })).output).toBe('hello world\n');
        expect((await call('file_write', { path: file, content: 'oops' })).success).toBe(false);
        const edit = { path: file, edits: [{ oldText: 'world', newText: 'Cynosure' }] };
        expect((await call('file_edit', { ...edit, dryRun: true })).output).toContain('Dry run only');
        expect(await fs.readFile(file, 'utf8')).toBe('hello world\n');
        const saved = await call('file_edit', edit);
        expect(saved.success, saved.output).toBe(true);
        expect(saved.output).toContain('+hello Cynosure');
        expect(await fs.readFile(file, 'utf8')).toBe('hello Cynosure\n');
        expect((await call('file_search', { path: root, pattern: '*.txt' })).output).toContain(file);
        expect((await call('directory_list', { path: path.dirname(file) })).output).toContain('one.txt');
    });

    it('reads a numbered line range and says how to continue', async () => {
        const file = path.join(root, 'long.txt');
        await fs.writeFile(file, Array.from({ length: 30 }, (_, index) => `line ${index + 1}`).join('\n') + '\n');

        const output = (await call('file_read', { path: file, offset: 10, limit: 3 })).output;

        expect(output).toBe('10\tline 10\n11\tline 11\n12\tline 12\n\n[Showing lines 10-12 of 30. Use offset: 13 to continue.]');
        expect((await call('file_read', { path: file, tail: 2 })).output).toContain('29\tline 29\n30\tline 30');
    });

    it('greps file contents with line numbers, globs, context, and a result cap', async () => {
        await fs.mkdir(path.join(root, 'src'));
        await fs.mkdir(path.join(root, 'node_modules'));
        await fs.writeFile(path.join(root, 'src', 'a.ts'), 'const alpha = 1\nfunction applyPatch() {}\nconst beta = 2\n');
        await fs.writeFile(path.join(root, 'src', 'b.vue'), '<script>applyPatch()</script>\n');
        await fs.writeFile(path.join(root, 'src', 'c.md'), 'applyPatch is documented here\n');
        await fs.writeFile(path.join(root, 'node_modules', 'dep.ts'), 'applyPatch()\n');
        await fs.writeFile(path.join(root, 'src', 'blob.bin'), Buffer.from([0, 1, 2, 97, 112, 112, 108, 121, 80, 97, 116, 99, 104]));

        const content = (await call('file_grep', { path: root, pattern: 'applyPatch', glob: '*.{ts,vue}', context: 1 })).output;
        expect(content).toContain('2 matching line(s) in 2 file(s)');
        expect(content).toContain(`${path.join(root, 'src', 'a.ts')}\n  1- const alpha = 1\n  2: function applyPatch() {}\n  3- const beta = 2`);
        expect(content).toContain('1: <script>applyPatch()</script>');
        expect(content).not.toContain('node_modules');
        expect(content).not.toContain('c.md');

        const files = (await call('file_grep', { path: root, pattern: 'APPLYPATCH', ignoreCase: true, outputMode: 'files' })).output;
        expect(files).toContain('3 matching file(s)');
        expect(files).not.toContain('blob.bin');

        const capped = (await call('file_grep', { path: root, pattern: 'applyPatch', maxResults: 1 })).output;
        expect(capped).toContain('1 matching line(s) in 1 file(s) shown');
        expect(capped).toContain('[Results stopped at 1.');
        expect((await call('file_grep', { path: root, pattern: 'missingName' })).output).toContain('No matches');
        expect((await call('file_grep', { path: root, pattern: '(' })).success).toBe(false);
    });

    it('caps file search and directory listings with a note', async () => {
        for (let index = 0; index < 5; index++) await fs.writeFile(path.join(root, `note-${index}.txt`), '');

        const search = (await call('file_search', { path: root, pattern: 'note-*', maxResults: 2 })).output;
        expect(search.split('\n').filter(line => line.startsWith(root))).toHaveLength(2);
        expect(search).toContain('more exist');

        const list = (await call('directory_list', { path: root, maxEntries: 3 })).output;
        expect(list).toContain('[Showing 3 of 5 entries.');

        const tree = (await call('directory_list', { path: root, tree: true, maxEntries: 3 })).output;
        expect(tree).toContain('"omittedChildren": 3');
    });

    it('refuses ambiguous or missing edits without saving any of them', async () => {
        const file = path.join(root, 'code.ts');
        const original = 'function a() {\n  return 1\n}\n\nfunction b() {\n  return 1\n}\n';
        await fs.writeFile(file, original);

        const ambiguous = await call('file_edit', { path: file, edits: [{ oldText: 'function a', newText: 'function first' }, { oldText: '  return 1', newText: '  return 2' }] });
        expect(ambiguous.success).toBe(false);
        expect(ambiguous.structuredContent).toMatchObject({ status: 'conflict', reason: 'ambiguous_context', editIndex: 1, matchCount: 2, lines: [2, 6] });
        expect(await fs.readFile(file, 'utf8')).toBe(original);

        const missing = await call('file_edit', { path: file, edits: [{ oldText: 'function b() {\n  return 3', newText: 'x' }] });
        expect(missing.structuredContent).toMatchObject({ reason: 'expected_context_not_found', lines: [5] });

        const all = await call('file_edit', { path: file, edits: [{ oldText: 'return 1', newText: 'return 2', replaceAll: true }] });
        expect(all.output).toContain('2 replacement(s)');
        expect(await fs.readFile(file, 'utf8')).toBe(original.replaceAll('return 1', 'return 2'));
    });

    it('creates and merges directories through their directory tools', async () => {
        const source = path.join(root, 'source');
        const destination = path.join(root, 'destination');
        expect((await call('directory_create', { path: source })).success).toBe(true);
        expect((await call('directory_create', { path: destination })).success).toBe(true);
        await fs.writeFile(path.join(source, 'note.txt'), 'moved');
        const result = await call('directory_merge', { source, destination });
        expect(result.success, result.output).toBe(true);
        expect(await fs.readFile(path.join(destination, 'note.txt'), 'utf8')).toBe('moved');
        await expect(fs.access(source)).rejects.toThrow();
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
            expect(result.output).toBe('1\tapproved');
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

    it('checks both directory_merge paths before execution', async () => {
        const source = path.join(root, 'source');
        await fs.mkdir(source);
        const unsubscribe = getEventBus().on('hitl:request', (event) => {
            const request = event as { toolCalls: Array<{ fileAccess?: { path: string } }>; resolve: (result: { approved: boolean }) => void };
            expect(request.toolCalls[0].fileAccess?.path).toBe(outside);
            request.resolve({ approved: false });
        });
        try {
            await expect(preflightFileToolAccess({
                toolName: 'directory_merge',
                arguments: { source, destination: outside },
                conversationId: 'conversation-test',
            })).rejects.toThrow('denied by the user');
            expect(listFileAccessRoots()).toEqual([root]);
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
            expect(result.output).toBe('1\tread after approval');
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
