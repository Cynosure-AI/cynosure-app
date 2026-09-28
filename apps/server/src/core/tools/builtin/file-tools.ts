import { promises as fs, createWriteStream } from 'node:fs';
import * as path from 'node:path';
import { EOL } from 'node:os';
import sharp from 'sharp';
import archiver from 'archiver';
import unzipper from 'unzipper';
import { z } from 'zod';
import { listFileAccessRoots, resolveFileAccessPath } from './file-access-policy.js';
import type { ToolDefinition, ToolResult, ToolResultContent } from '../../gateway/providers/base.provider.js';

type SortBy = 'name' | 'size' | 'modified';

interface FileEntry {
    name: string;
    path: string;
    type: 'file' | 'directory' | 'symlink' | 'other';
    size: number;
    modified: string;
}

interface TreeEntry {
    name: string;
    path: string;
    type: FileEntry['type'];
    size?: number;
    children?: TreeEntry[];
}

const DEFAULT_EXCLUDE_PATTERNS = [
    'node_modules',
    '.git',
    '.svn',
    '.hg',
    'dist',
    'build',
    'out',
    '.next',
    '.nuxt',
    '.cache',
    '.parcel-cache',
    '.turbo',
    '.vercel',
    'coverage',
    '.pytest_cache',
    '__pycache__',
    '.venv',
    'venv',
    'target',
    'vendor',
    '.DS_Store',
];

const TEXT_DECODER = new TextDecoder('utf-8', { fatal: false });
const MAX_MEDIA_BYTES = 25 * 1024 * 1024;

const IMAGE_MIME_BY_EXT: Record<string, string> = {
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.avif': 'image/avif',
    '.tif': 'image/tiff',
    '.tiff': 'image/tiff',
    '.bmp': 'image/bmp',
    '.svg': 'image/svg+xml',
};

const MEDIA_MIME_BY_EXT: Record<string, string> = {
    ...IMAGE_MIME_BY_EXT,
    '.mp3': 'audio/mpeg',
    '.wav': 'audio/wav',
    '.ogg': 'audio/ogg',
    '.flac': 'audio/flac',
    '.m4a': 'audio/mp4',
    '.mp4': 'video/mp4',
    '.webm': 'video/webm',
    '.mov': 'video/quicktime',
    '.mkv': 'video/x-matroska',
};

function isWithin(parent: string, child: string): boolean {
    const rel = path.relative(parent, child);
    return rel === '' || (!!rel && !rel.startsWith('..') && !path.isAbsolute(rel));
}

async function assertNotAllowedRoot(candidate: string): Promise<void> {
    for (const root of listFileAccessRoots()) {
        const realRoot = await fs.realpath(root).catch(() => root);
        if (candidate === realRoot) throw new Error('Cannot move or delete an allowed directory root.');
    }
}

const resolveAllowedPath = resolveFileAccessPath;

function globToRegExp(pattern: string): RegExp {
    const escaped = pattern
        .replace(/[.+^${}()|[\]\\]/g, '\\$&')
        .replace(/\*/g, '.*')
        .replace(/\?/g, '.');
    return new RegExp(`^${escaped}$`, 'i');
}

function searchPatternToRegExp(pattern: string): RegExp {
    if (pattern.includes('*') || pattern.includes('?')) return globToRegExp(pattern);
    const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(escaped, 'i');
}

function shouldExclude(name: string, fullPath: string, patterns: string[] = []): boolean {
    const allPatterns = [...DEFAULT_EXCLUDE_PATTERNS, ...patterns].filter(Boolean);
    const normalized = fullPath.split(path.sep).join('/');

    return allPatterns.some(pattern => {
        if (pattern.includes('*') || pattern.includes('?')) {
            const re = globToRegExp(pattern);
            return re.test(name) || re.test(normalized);
        }
        return name === pattern || normalized.includes(`/${pattern}/`) || normalized.endsWith(`/${pattern}`);
    });
}

function entryType(stats: Awaited<ReturnType<typeof fs.lstat>>): FileEntry['type'] {
    if (stats.isDirectory()) return 'directory';
    if (stats.isFile()) return 'file';
    if (stats.isSymbolicLink()) return 'symlink';
    return 'other';
}

async function toFileEntry(fullPath: string, name = path.basename(fullPath)): Promise<FileEntry> {
    const stats = await fs.lstat(fullPath);
    return {
        name,
        path: fullPath,
        type: entryType(stats),
        size: stats.size,
        modified: stats.mtime.toISOString(),
    };
}

function sortEntries(entries: FileEntry[], sortBy: SortBy = 'name'): FileEntry[] {
    return entries.sort((a, b) => {
        if (a.type !== b.type) return a.type === 'directory' ? -1 : b.type === 'directory' ? 1 : 0;
        if (sortBy === 'size') return b.size - a.size || a.name.localeCompare(b.name);
        if (sortBy === 'modified') return b.modified.localeCompare(a.modified) || a.name.localeCompare(b.name);
        return a.name.localeCompare(b.name);
    });
}

function formatBytes(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    const units = ['KB', 'MB', 'GB', 'TB'];
    let size = bytes / 1024;
    let unit = 0;
    while (size >= 1024 && unit < units.length - 1) {
        size /= 1024;
        unit++;
    }
    return `${size.toFixed(size >= 10 ? 1 : 2)} ${units[unit]}`;
}

async function directorySize(dir: string, excludePatterns: string[] = []): Promise<number> {
    let total = 0;
    const entries = await fs.readdir(dir, { withFileTypes: true });

    for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (shouldExclude(entry.name, fullPath, excludePatterns)) continue;
        const stats = await fs.lstat(fullPath);
        if (stats.isDirectory()) total += await directorySize(fullPath, excludePatterns);
        else total += stats.size;
    }

    return total;
}

async function readDirectoryEntries(dir: string, includeSizes = false, sortBy: SortBy = 'name'): Promise<FileEntry[]> {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    const result: FileEntry[] = [];

    for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (shouldExclude(entry.name, fullPath)) continue;
        const info = await toFileEntry(fullPath, entry.name);
        if (includeSizes && info.type === 'directory') info.size = await directorySize(fullPath);
        result.push(info);
    }

    return sortEntries(result, sortBy);
}

async function buildTree(dir: string, depth: number, excludePatterns: string[]): Promise<TreeEntry> {
    const info = await toFileEntry(dir);
    const node: TreeEntry = {
        name: info.name || dir,
        path: info.path,
        type: info.type,
        size: info.size,
    };

    if (info.type !== 'directory' || depth <= 0) return node;

    const children = await fs.readdir(dir, { withFileTypes: true });
    node.children = [];
    for (const child of children.sort((a, b) => a.name.localeCompare(b.name))) {
        const childPath = path.join(dir, child.name);
        if (shouldExclude(child.name, childPath, excludePatterns)) continue;
        node.children.push(await buildTree(childPath, depth - 1, excludePatterns));
    }
    return node;
}

async function searchFilesRecursive(dir: string, matcher: RegExp, excludePatterns: string[], results: string[]): Promise<void> {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (shouldExclude(entry.name, fullPath, excludePatterns)) continue;
        if (matcher.test(entry.name) || matcher.test(fullPath)) results.push(fullPath);
        if (entry.isDirectory()) await searchFilesRecursive(fullPath, matcher, excludePatterns, results);
    }
}

function limitText(text: string, head?: number, tail?: number): string {
    const lines = text.split(/\r?\n/);
    if (head !== undefined && tail !== undefined) {
        return [
            ...lines.slice(0, head),
            `... omitted ${Math.max(0, lines.length - head - tail)} line(s) ...`,
            ...lines.slice(Math.max(head, lines.length - tail)),
        ].join(EOL);
    }
    if (head !== undefined) return lines.slice(0, head).join(EOL);
    if (tail !== undefined) return lines.slice(Math.max(0, lines.length - tail)).join(EOL);
    return text;
}

async function readText(absPath: string, head?: number, tail?: number): Promise<string> {
    const buffer = await fs.readFile(absPath);
    return limitText(TEXT_DECODER.decode(buffer), head, tail);
}

function mimeForPath(filePath: string): string {
    return MEDIA_MIME_BY_EXT[path.extname(filePath).toLowerCase()] ?? 'application/octet-stream';
}

function isImagePath(filePath: string): boolean {
    return path.extname(filePath).toLowerCase() in IMAGE_MIME_BY_EXT;
}

function escapeXml(value: string): string {
    return value
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&apos;');
}

function truncateMiddle(value: string, maxLength: number): string {
    if (value.length <= maxLength) return value;
    const side = Math.floor((maxLength - 3) / 2);
    return `${value.slice(0, side)}...${value.slice(value.length - side)}`;
}

function captionSvg(width: number, height: number, title: string, index: number): Buffer {
    const label = escapeXml(`${index}. ${truncateMiddle(title, 44)}`);
    return Buffer.from(`
        <svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
            <rect width="100%" height="100%" fill="#f7f7f7"/>
            <text x="12" y="28" font-family="Arial, Helvetica, sans-serif" font-size="18" font-weight="600" fill="#222">${label}</text>
        </svg>
    `);
}

async function createImageCollage(paths: string[], tileSize: number): Promise<{ data: Buffer; width: number; height: number; files: Array<{ name: string; path: string }> }> {
    if (paths.length < 1 || paths.length > 6) throw new Error('read_multiple_media_files supports 1 to 6 images per call.');

    const absPaths = [];
    for (const filePath of paths) {
        const absPath = await resolveAllowedPath(filePath);
        if (!isImagePath(absPath)) throw new Error(`Not a supported image file: ${filePath}`);
        absPaths.push(absPath);
    }

    const columns = Math.min(3, absPaths.length);
    const rows = Math.ceil(absPaths.length / columns);
    const margin = 24;
    const gap = 18;
    const captionHeight = 46;
    const cellWidth = tileSize;
    const imageHeight = tileSize;
    const cellHeight = imageHeight + captionHeight;
    const width = margin * 2 + columns * cellWidth + (columns - 1) * gap;
    const height = margin * 2 + rows * cellHeight + (rows - 1) * gap;
    const composites: sharp.OverlayOptions[] = [];
    const files: Array<{ name: string; path: string }> = [];

    for (let i = 0; i < absPaths.length; i++) {
        const absPath = absPaths[i];
        const col = i % columns;
        const row = Math.floor(i / columns);
        const left = margin + col * (cellWidth + gap);
        const top = margin + row * (cellHeight + gap);

        const image = await sharp(absPath)
            .rotate()
            .resize({ width: cellWidth, height: imageHeight, fit: 'inside', withoutEnlargement: true })
            .png()
            .toBuffer({ resolveWithObject: true });

        const imageLeft = left + Math.floor((cellWidth - image.info.width) / 2);
        const imageTop = top + Math.floor((imageHeight - image.info.height) / 2);
        composites.push({ input: image.data, left: imageLeft, top: imageTop });
        composites.push({ input: captionSvg(cellWidth, captionHeight, path.basename(absPath), i + 1), left, top: top + imageHeight });
        files.push({ name: path.basename(absPath), path: absPath });
    }

    const data = await sharp({
        create: {
            width,
            height,
            channels: 4,
            background: '#ffffff',
        },
    })
        .composite(composites)
        .png()
        .toBuffer();

    return { data, width, height, files };
}

function unifiedDiff(original: string, updated: string): string {
    const before = original.split(/\r?\n/);
    const after = updated.split(/\r?\n/);
    const lines = ['--- original', '+++ updated'];
    const max = Math.max(before.length, after.length);
    for (let i = 0; i < max; i++) {
        if (before[i] === after[i]) {
            lines.push(` ${before[i] ?? ''}`);
        } else {
            if (before[i] !== undefined) lines.push(`-${before[i]}`);
            if (after[i] !== undefined) lines.push(`+${after[i]}`);
        }
    }
    return lines.join('\n');
}

function errorCode(err: unknown): string | undefined {
    if (typeof err === 'object' && err !== null && 'code' in err && typeof err.code === 'string') {
        return err.code;
    }
    return undefined;
}

async function pathExists(candidate: string): Promise<boolean> {
    try {
        await fs.lstat(candidate);
        return true;
    } catch (err) {
        if (errorCode(err) === 'ENOENT') return false;
        throw err;
    }
}

async function assertPathType(candidate: string, expected: 'file' | 'directory'): Promise<void> {
    const stats = await fs.lstat(candidate);
    const matches = expected === 'file' ? stats.isFile() : stats.isDirectory();
    if (!matches) {
        throw new Error(`Path is not a ${expected}.`);
    }
}

function assertNotNested(source: string, destination: string): void {
    if (isWithin(source, destination)) {
        throw new Error('Destination cannot be the source directory itself or a location inside it.');
    }
}

async function copyFileSafely(source: string, destination: string, overwrite: boolean): Promise<void> {
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await fs.copyFile(source, destination, overwrite ? 0 : fs.constants.COPYFILE_EXCL);
}

async function moveFilePath(source: string, destination: string, overwrite: boolean): Promise<string> {
    const destinationExists = await pathExists(destination);
    if (destinationExists) {
        const destinationStats = await fs.lstat(destination);
        if (destinationStats.isDirectory()) {
            destination = path.join(destination, path.basename(source));
        }
    }

    if (source === destination) throw new Error('Source and destination are the same file.');

    if (await pathExists(destination)) {
        const destinationStats = await fs.lstat(destination);
        if (!destinationStats.isFile()) throw new Error(`Destination exists and is not a file: ${destination}`);
        if (!overwrite) throw Object.assign(new Error(`Destination file already exists: ${destination}`), { code: 'EEXIST' });
        await fs.rm(destination);
    }

    await fs.mkdir(path.dirname(destination), { recursive: true });
    try {
        await fs.rename(source, destination);
    } catch (err) {
        if (errorCode(err) !== 'EXDEV') throw err;
        await copyFileSafely(source, destination, overwrite);
        await fs.unlink(source);
    }
    return destination;
}

async function collectMergeConflicts(source: string, destination: string, conflicts: string[]): Promise<void> {
    for (const entry of await fs.readdir(source, { withFileTypes: true })) {
        const sourceChild = path.join(source, entry.name);
        const destinationChild = path.join(destination, entry.name);
        if (!await pathExists(destinationChild)) continue;

        const sourceStats = await fs.lstat(sourceChild);
        const destinationStats = await fs.lstat(destinationChild);
        if (sourceStats.isDirectory() && destinationStats.isDirectory()) {
            await collectMergeConflicts(sourceChild, destinationChild, conflicts);
        } else {
            conflicts.push(destinationChild);
        }
    }
}

async function mergeDirectory(source: string, destination: string, overwrite: boolean): Promise<void> {
    if (!overwrite) {
        const conflicts: string[] = [];
        await collectMergeConflicts(source, destination, conflicts);
        if (conflicts.length > 0) {
            const preview = conflicts.slice(0, 10).join(', ');
            const suffix = conflicts.length > 10 ? `, and ${conflicts.length - 10} more` : '';
            throw Object.assign(new Error(`Merge would overwrite ${conflicts.length} existing path(s): ${preview}${suffix}`), { code: 'EEXIST' });
        }
    }

    for (const entry of await fs.readdir(source, { withFileTypes: true })) {
        const sourceChild = path.join(source, entry.name);
        const destinationChild = path.join(destination, entry.name);
        const destinationExists = await pathExists(destinationChild);

        if (entry.isDirectory() && destinationExists && (await fs.lstat(destinationChild)).isDirectory()) {
            await mergeDirectory(sourceChild, destinationChild, overwrite);
            continue;
        }
        if (destinationExists) await fs.rm(destinationChild, { recursive: true });
        await fs.mkdir(path.dirname(destinationChild), { recursive: true });
        try {
            await fs.rename(sourceChild, destinationChild);
        } catch (err) {
            if (errorCode(err) !== 'EXDEV') throw err;
            await fs.cp(sourceChild, destinationChild, { recursive: true, force: overwrite, errorOnExist: !overwrite });
            await fs.rm(sourceChild, { recursive: true });
        }
    }
    await fs.rmdir(source);
}

async function moveDirectoryPath(source: string, destination: string): Promise<void> {
    assertNotNested(source, destination);
    if (await pathExists(destination)) {
        throw Object.assign(new Error(
            `Destination already exists: ${destination}. ` +
            `move requires an exact new path, including the source directory name. ` +
            `Use merge only when you intend to move the source contents into an existing directory.`,
        ), { code: 'EEXIST' });
    }

    await fs.mkdir(path.dirname(destination), { recursive: true });
    try {
        await fs.rename(source, destination);
    } catch (err) {
        if (errorCode(err) !== 'EXDEV') throw err;
        await fs.cp(source, destination, { recursive: true, force: false, errorOnExist: true });
        await fs.rm(source, { recursive: true });
    }
}

async function mergeDirectoryPath(source: string, destination: string, overwrite: boolean): Promise<void> {
    assertNotNested(source, destination);
    if (!await pathExists(destination)) {
        throw Object.assign(new Error(
            `Merge destination does not exist: ${destination}. ` +
            `merge requires an existing destination directory. Use move to move or rename a directory to a new path.`,
        ), { code: 'ENOENT' });
    }
    const destinationStats = await fs.lstat(destination);
    if (!destinationStats.isDirectory()) throw new Error(`Merge destination is not a directory: ${destination}`);
    await mergeDirectory(source, destination, overwrite);
}

function archiveEntryName(filePath: string): string {
    const name = path.basename(filePath);
    if (!name || name === path.sep) throw new Error(`Cannot archive a filesystem root directly: ${filePath}`);
    return name;
}

async function createZipArchive(filePaths: string[], destination: string, overwrite: boolean): Promise<void> {
    const absDestination = await resolveAllowedPath(destination);
    const sources: Array<{ absPath: string; name: string; isDirectory: boolean }> = [];
    const topLevelNames = new Set<string>();

    for (const filePath of filePaths) {
        const absPath = await resolveAllowedPath(filePath);
        const stats = await fs.lstat(absPath);
        if (!stats.isFile() && !stats.isDirectory()) throw new Error(`Unsupported archive input type: ${filePath}`);
        const name = archiveEntryName(absPath);
        if (topLevelNames.has(name)) throw new Error(`Duplicate top-level archive name "${name}". Rename an input or archive it separately.`);
        topLevelNames.add(name);
        if (stats.isDirectory() && isWithin(absPath, absDestination)) {
            throw new Error(`Archive destination cannot be inside an input directory: ${absPath}`);
        }
        sources.push({ absPath, name, isDirectory: stats.isDirectory() });
    }

    if (await pathExists(absDestination)) {
        if (!overwrite) throw Object.assign(new Error(`Archive already exists: ${absDestination}`), { code: 'EEXIST' });
        const stats = await fs.lstat(absDestination);
        if (!stats.isFile()) throw new Error(`Archive destination is not a file: ${absDestination}`);
    }

    await fs.mkdir(path.dirname(absDestination), { recursive: true });
    await new Promise<void>((resolve, reject) => {
        const output = createWriteStream(absDestination, { flags: overwrite ? 'w' : 'wx' });
        const archive = archiver('zip', { zlib: { level: 9 } });
        const fail = (err: Error) => reject(err);
        output.on('close', resolve);
        output.on('error', fail);
        archive.on('error', fail);
        archive.pipe(output);
        for (const source of sources) {
            if (source.isDirectory) archive.directory(source.absPath, source.name);
            else archive.file(source.absPath, { name: source.name });
        }
        void archive.finalize();
    }).catch(async err => {
        await fs.rm(absDestination, { force: true }).catch(() => undefined);
        throw err;
    });
}

function safeZipEntryPath(destination: string, entryPath: string): string {
    const normalized = entryPath.replace(/\\/g, '/');
    if (normalized.includes('\0') || normalized.startsWith('/') || /^[A-Za-z]:\//.test(normalized)) {
        throw new Error(`Unsafe absolute ZIP entry path: ${entryPath}`);
    }
    const target = path.resolve(destination, normalized);
    if (!isWithin(destination, target)) throw new Error(`Unsafe ZIP entry escapes destination: ${entryPath}`);
    return target;
}

async function extractZipArchive(archivePath: string, destination: string | undefined, overwrite: boolean): Promise<string> {
    const absArchive = await resolveAllowedPath(archivePath);
    await assertPathType(absArchive, 'file');
    const defaultDestination = path.join(path.dirname(absArchive), path.basename(absArchive, path.extname(absArchive)));
    const absDestination = await resolveAllowedPath(destination ?? defaultDestination);
    const zip = await unzipper.Open.file(absArchive);
    const entries = [];
    const archiveTargets = new Set<string>();
    for (const entry of zip.files) {
        const target = safeZipEntryPath(absDestination, entry.path);
        const resolvedTarget = await resolveAllowedPath(target);
        if (!isWithin(absDestination, resolvedTarget)) {
            throw new Error(`Unsafe ZIP entry resolves outside destination through a symbolic link: ${entry.path}`);
        }
        if (archiveTargets.has(resolvedTarget)) {
            throw new Error(`ZIP archive contains duplicate destination entries: ${entry.path}`);
        }
        archiveTargets.add(resolvedTarget);
        entries.push({ entry, target: resolvedTarget });
    }

    const conflicts = [];
    for (const { entry, target } of entries) {
        if (!await pathExists(target)) continue;
        const existingStats = await fs.lstat(target);
        const typeMatches = entry.type === 'Directory' ? existingStats.isDirectory() : existingStats.isFile();
        if (!typeMatches) {
            throw new Error(`ZIP entry type conflicts with existing path: ${target}`);
        }
        if (!overwrite && entry.type !== 'Directory') conflicts.push(target);
    }
    if (conflicts.length > 0) {
        throw Object.assign(new Error(`Extraction would overwrite ${conflicts.length} existing file(s): ${conflicts.slice(0, 10).join(', ')}`), { code: 'EEXIST' });
    }

    await fs.mkdir(absDestination, { recursive: true });
    for (const { entry, target } of entries) {
        if (entry.type === 'Directory') {
            await fs.mkdir(target, { recursive: true });
            continue;
        }
        if (entry.type !== 'File') throw new Error(`Unsupported ZIP entry type for ${entry.path}: ${entry.type}`);
        await fs.mkdir(path.dirname(target), { recursive: true });
        if (overwrite) await fs.rm(target, { force: true });
        await new Promise<void>((resolve, reject) => {
            const output = createWriteStream(target, { flags: 'wx' });
            entry.stream().on('error', reject).pipe(output).on('error', reject).on('finish', resolve);
        });
    }
    return absDestination;
}


const pathField = z.string().min(1).describe('Absolute or relative filesystem path inside an allowed directory.');
const excludeField = z.array(z.string()).optional().describe('Additional names or glob patterns to exclude.');

function textResult(output: string): ToolResult {
    return { success: true, output };
}

function jsonResult(value: unknown): ToolResult {
    return textResult(JSON.stringify(value, null, 2));
}

function tool<S extends z.ZodObject<z.ZodRawShape>>(
    name: string,
    description: string,
    schema: S,
    readOnly: boolean,
    destructive: boolean,
    handler: (args: z.infer<S>) => Promise<ToolResult>,
): ToolDefinition {
    // Cynosure's AJV validator uses draft 7; these schemas only use keywords
    // supported there, so omit Zod's draft 2020-12 declaration.
    const parameters = z.toJSONSchema(schema) as Record<string, unknown>;
    delete parameters.$schema;
    return {
        name,
        description,
        parameters,
        timeout: 120_000,
        execution: { readOnly },
        annotations: { readOnlyHint: readOnly, destructiveHint: destructive, idempotentHint: readOnly, openWorldHint: false },
        execute: async (params: unknown) => {
            try {
                return await handler(schema.parse(params));
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                return { success: false, output: `File ${name} failed: ${message}`, error: message };
            }
        },
    };
}

export function makeFileTools(): ToolDefinition[] {
    const define = <S extends z.ZodObject<z.ZodRawShape>>(
        name: string,
        description: string,
        schema: S,
        readOnly: boolean,
        destructive: boolean,
        handler: (args: z.infer<S>) => Promise<ToolResult>,
    ) => tool(name, description, schema, readOnly, destructive, handler);
    return [
        define('file_info', 'Get file or directory metadata. Omit path to list the directory roots available to native file tools.',
            z.object({ path: pathField.optional() }), true, false,
            async ({ path: inputPath }) => {
                if (inputPath === undefined) return jsonResult({ allowedDirectories: listFileAccessRoots() });
                return jsonResult(await toFileEntry(await resolveAllowedPath(inputPath)));
            }),
        define('directory_list', 'List a directory or return a tree. Common dependency, build, and cache folders are excluded.',
            z.object({
                path: pathField,
                tree: z.boolean().optional(),
                depth: z.number().int().min(0).max(10).optional(),
                includeSizes: z.boolean().optional(),
                sortBy: z.enum(['name', 'size', 'modified']).optional(),
                excludePatterns: excludeField,
            }), true, false,
            async ({ path: inputPath, tree, depth, includeSizes, sortBy, excludePatterns }) => {
                const absPath = await resolveAllowedPath(inputPath);
                if (tree) return jsonResult(await buildTree(absPath, depth ?? 3, excludePatterns ?? []));
                const entries = await readDirectoryEntries(absPath, includeSizes ?? false, sortBy);
                return jsonResult(includeSizes ? entries.map(entry => ({ ...entry, sizeHuman: formatBytes(entry.size) })) : entries);
            }),
        define('file_search', 'Search file and directory names or paths with a case-insensitive pattern. Supports * and ?.',
            z.object({ path: pathField, pattern: z.string().min(1), excludePatterns: excludeField }), true, false,
            async ({ path: inputPath, pattern, excludePatterns }) => {
                const results: string[] = [];
                await searchFilesRecursive(await resolveAllowedPath(inputPath), searchPatternToRegExp(pattern), excludePatterns ?? [], results);
                return jsonResult(results);
            }),
        define('file_read', 'Read one or more text or media files. Text is the default; media, thumbnails, and collage return image content when applicable.',
            z.object({
                path: pathField.optional(),
                paths: z.array(pathField).min(1).max(100).optional(),
                mode: z.enum(['text', 'media', 'thumbnails', 'collage']).optional(),
                head: z.number().int().positive().optional(),
                tail: z.number().int().positive().optional(),
                size: z.number().int().min(32).max(1024).optional(),
                tileSize: z.number().int().min(160).max(512).optional(),
            }), true, false,
            async ({ path: inputPath, paths, mode, head, tail, size, tileSize }) => {
                if ((inputPath === undefined) === (paths === undefined)) throw new Error('Provide exactly one of path or paths.');
                const requestedPaths = inputPath === undefined ? paths! : [inputPath];
                const readMode = mode ?? 'text';
                if (readMode === 'collage') {
                    const collage = await createImageCollage(requestedPaths, tileSize ?? 320);
                    const dataUrl = `data:image/png;base64,${collage.data.toString('base64')}`;
                    const output = JSON.stringify({ mimeType: 'image/png', width: collage.width, height: collage.height, files: collage.files }, null, 2);
                    return { success: true, output, content: [{ type: 'text', text: output }, { type: 'image', mimeType: 'image/png', data: collage.data.toString('base64') }], imageDataUrls: [dataUrl] };
                }
                if (readMode === 'thumbnails' || readMode === 'media') {
                    const content: ToolResultContent[] = [];
                    const imageDataUrls: string[] = [];
                    const output: string[] = [];
                    for (const filePath of requestedPaths) {
                        const absPath = await resolveAllowedPath(filePath);
                        if (readMode === 'thumbnails') {
                            if (!isImagePath(absPath)) throw new Error(`Not a supported image file: ${filePath}`);
                            const thumb = await sharp(absPath).rotate().resize({ width: size ?? 256, height: size ?? 256, fit: 'inside', withoutEnlargement: true }).png().toBuffer();
                            const metadata = JSON.stringify({ name: path.basename(absPath), path: absPath, mimeType: 'image/png' });
                            output.push(metadata);
                            content.push({ type: 'text', text: metadata }, { type: 'image', data: thumb.toString('base64'), mimeType: 'image/png' });
                            imageDataUrls.push(`data:image/png;base64,${thumb.toString('base64')}`);
                            continue;
                        }
                        const stats = await fs.stat(absPath);
                        if (!stats.isFile()) throw new Error(`Not a file: ${filePath}`);
                        if (stats.size > MAX_MEDIA_BYTES) throw new Error(`Media file is too large (${formatBytes(stats.size)}). Limit is ${formatBytes(MAX_MEDIA_BYTES)}.`);
                        const data = await fs.readFile(absPath);
                        const mimeType = mimeForPath(absPath);
                        const metadata = { path: absPath, mimeType, size: stats.size, sizeHuman: formatBytes(stats.size) };
                        if (isImagePath(absPath)) {
                            const details = JSON.stringify(metadata, null, 2);
                            output.push(details);
                            content.push({ type: 'text', text: details }, { type: 'image', data: data.toString('base64'), mimeType });
                            imageDataUrls.push(`data:${mimeType};base64,${data.toString('base64')}`);
                        } else {
                            const details = JSON.stringify({ ...metadata, base64: data.toString('base64') }, null, 2);
                            output.push(details);
                            content.push({ type: 'text', text: details });
                        }
                    }
                    return { success: true, output: output.join('\n'), content, imageDataUrls };
                }
                const files = [];
                for (const filePath of requestedPaths) {
                    const absPath = await resolveAllowedPath(filePath);
                    files.push({ path: absPath, content: await readText(absPath, head, tail) });
                }
                return textResult(files.length === 1 ? files[0].content : JSON.stringify(files, null, 2));
            }),
        define('file_write', 'Write a UTF-8 text file. Existing files require overwrite: true.',
            z.object({ path: pathField, content: z.string(), overwrite: z.boolean().optional() }), false, true,
            async ({ path: inputPath, content, overwrite }) => {
                const absPath = await resolveAllowedPath(inputPath);
                await fs.mkdir(path.dirname(absPath), { recursive: true });
                await fs.writeFile(absPath, content, { encoding: 'utf8', flag: overwrite ? 'w' : 'wx' });
                return textResult(`Wrote file: ${absPath}`);
            }),
        define('file_edit', 'Apply ordered, exact text replacements to a UTF-8 file. Preview only by default; set dryRun: false to save.',
            z.object({
                path: pathField,
                edits: z.array(z.object({ oldText: z.string().min(1), newText: z.string(), replaceAll: z.boolean().optional() })).min(1),
                dryRun: z.boolean().optional(),
            }), false, true,
            async ({ path: inputPath, edits, dryRun }) => {
                const absPath = await resolveAllowedPath(inputPath);
                const original = await readText(absPath);
                let updated = original;
                for (const edit of edits) {
                    if (!updated.includes(edit.oldText)) throw new Error(`oldText not found: ${edit.oldText.slice(0, 80)}`);
                    updated = edit.replaceAll ? updated.split(edit.oldText).join(edit.newText) : updated.replace(edit.oldText, edit.newText);
                }
                const previewOnly = dryRun ?? true;
                if (!previewOnly) await fs.writeFile(absPath, updated, 'utf8');
                return textResult(`${previewOnly ? 'Dry run only.' : `Edited file: ${absPath}`}\n\n${unifiedDiff(original, updated)}`);
            }),
        define('directory_create', 'Create a directory and any missing parent directories.',
            z.object({ path: pathField }), false, true,
            async ({ path: inputPath }) => {
                const absPath = await resolveAllowedPath(inputPath);
                await fs.mkdir(absPath, { recursive: true });
                return textResult(`Created directory: ${absPath}`);
            }),
        define('file_move', 'Move or rename a file or directory. A directory destination must be an exact new path; existing directories require directory_merge.',
            z.object({ source: pathField, destination: pathField, overwrite: z.boolean().optional() }), false, true,
            async ({ source, destination, overwrite }) => {
                const absSource = await resolveAllowedPath(source);
                const absDestination = await resolveAllowedPath(destination);
                const stats = await fs.lstat(absSource);
                if (stats.isFile()) {
                    const finalDestination = await moveFilePath(absSource, absDestination, overwrite ?? false);
                    return textResult(`Moved ${absSource} to ${finalDestination}`);
                }
                if (stats.isDirectory()) {
                    await assertNotAllowedRoot(absSource);
                    if (overwrite) throw new Error('overwrite is only supported when moving files. Use directory_merge to combine directories.');
                    await moveDirectoryPath(absSource, absDestination);
                    return textResult(`Moved directory ${absSource} to ${absDestination}`);
                }
                throw new Error('Source is neither a regular file nor a directory.');
            }),
        define('directory_merge', 'Merge the contents of a source directory into an existing destination directory and remove the empty source. Conflicts require overwrite: true.',
            z.object({ source: pathField, destination: pathField, overwrite: z.boolean().optional() }), false, true,
            async ({ source, destination, overwrite }) => {
                const absSource = await resolveAllowedPath(source);
                const absDestination = await resolveAllowedPath(destination);
                await assertPathType(absSource, 'directory');
                await assertNotAllowedRoot(absSource);
                await mergeDirectoryPath(absSource, absDestination, overwrite ?? false);
                return textResult(`Merged contents of ${absSource} into ${absDestination} and removed the source directory.`);
            }),
        define('file_archive', 'Create or extract a ZIP archive. Extraction rejects path traversal and does not overwrite by default.',
            z.object({
                action: z.enum(['create', 'extract']),
                filePaths: z.array(pathField).min(1).optional(),
                archivePath: pathField.optional(),
                destination: pathField.optional(),
                overwrite: z.boolean().optional(),
            }), false, true,
            async ({ action, filePaths, archivePath, destination, overwrite }) => {
                if (action === 'create') {
                    if (!filePaths || !destination) throw new Error('Creating an archive requires filePaths and destination.');
                    if (archivePath !== undefined) throw new Error('archivePath is only valid when extracting.');
                    await createZipArchive(filePaths, destination, overwrite ?? false);
                    return textResult(`Created ZIP archive: ${await resolveAllowedPath(destination)}`);
                }
                if (!archivePath) throw new Error('Extracting an archive requires archivePath.');
                if (filePaths !== undefined) throw new Error('filePaths is only valid when creating.');
                return textResult(`Extracted ZIP archive to: ${await extractZipArchive(archivePath, destination, overwrite ?? false)}`);
            }),
        define('file_delete', 'Delete a file or directory. A non-empty directory requires recursive: true.',
            z.object({ path: pathField, recursive: z.boolean().optional() }), false, true,
            async ({ path: inputPath, recursive }) => {
                const absPath = await resolveAllowedPath(inputPath);
                const stats = await fs.lstat(absPath);
                if (stats.isFile()) {
                    await fs.unlink(absPath);
                    return textResult(`Deleted file: ${absPath}`);
                }
                if (stats.isDirectory()) {
                    await assertNotAllowedRoot(absPath);
                    if (recursive) await fs.rm(absPath, { recursive: true });
                    else await fs.rmdir(absPath);
                    return textResult(`Deleted directory: ${absPath}`);
                }
                throw new Error('Path is neither a regular file nor a directory.');
            }),
    ];
}
