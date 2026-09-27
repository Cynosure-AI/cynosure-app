import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import sharp from 'sharp';
import AdmZip from 'adm-zip';
import { makeFileTools } from './file-tools.js';
import { getBuiltInToolKey, getBuiltInNamespace, hydrateBuiltInTools } from '../built-in-tools.js';

let sandbox: string;
let root: string;
let outside: string;
let previousRoots: string | undefined;

async function call(name: string, params: unknown) {
    const tool = makeFileTools().find(candidate => candidate.name === name);
    if (!tool) throw new Error(`Missing tool ${name}`);
    return tool.execute(params);
}

beforeEach(async () => {
    previousRoots = process.env.FILE_ACCESS_ALLOWED_DIRECTORIES;
    sandbox = await fs.mkdtemp(path.join(tmpdir(), 'cynosure-native-files-'));
    root = path.join(sandbox, 'allowed');
    outside = path.join(sandbox, 'outside');
    await fs.mkdir(root);
    await fs.mkdir(outside);
    process.env.FILE_ACCESS_ALLOWED_DIRECTORIES = root;
});

afterEach(async () => {
    if (previousRoots === undefined) delete process.env.FILE_ACCESS_ALLOWED_DIRECTORIES;
    else process.env.FILE_ACCESS_ALLOWED_DIRECTORIES = previousRoots;
    await fs.rm(sandbox, { recursive: true, force: true });
});

describe('native file tools', () => {
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
        expect((await call('file_write', { path: file, content: 'hello world\n' })).success).toBe(true);
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
        expect((await call('file_read', { path: target })).success).toBe(false);
        expect((await call('file_read', { path: path.join(root, 'escape', 'secret.txt') })).success).toBe(false);
        expect((await call('file_write', { path: path.join(root, 'escape', 'new.txt'), content: 'no' })).success).toBe(false);
        expect((await call('file_delete', { path: root, recursive: true })).success).toBe(false);
        expect(await fs.readFile(target, 'utf8')).toBe('secret');
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
