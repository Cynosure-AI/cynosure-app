/**
 * Text handling for the native file tools: line-addressed reads, bounded
 * content search, and exact-match edits. Kept free of filesystem access so the
 * rules are easy to test.
 */
import { createTwoFilesPatch } from 'diff';
import { normalizePatchText } from './patch-text.js';

export const DEFAULT_READ_LINES = 2000;
const MAX_LINE_CHARS = 2000;
const MAX_DIFF_CHARS = 12_000;

/** Split text into lines without the empty entry a trailing newline would add. */
export function splitLines(text: string): string[] {
    if (text === '') return [];
    const lines = text.split(/\r?\n/);
    if (lines[lines.length - 1] === '') lines.pop();
    return lines;
}

function clipLine(line: string, maxChars: number): string {
    return line.length > maxChars ? `${line.slice(0, maxChars)}… [line truncated, ${line.length} chars]` : line;
}

export interface ReadWindow {
    /** 1-based first line. */
    offset?: number;
    limit?: number;
    head?: number;
    tail?: number;
    lineNumbers?: boolean;
}

/**
 * Render the requested lines of a text file. Lines are numbered as
 * `<line>\t<text>` by default, so a later read or edit can target them, and a
 * note says how to continue when the window does not cover the whole file.
 */
export function renderTextWindow(text: string, window: ReadWindow = {}): string {
    const { head, tail, lineNumbers = true } = window;
    const lines = splitLines(text);
    const total = lines.length;
    const render = (from: number, to: number) => lines.slice(from, to)
        .map((line, index) => lineNumbers ? `${from + index + 1}\t${clipLine(line, MAX_LINE_CHARS)}` : clipLine(line, MAX_LINE_CHARS));

    if (head !== undefined && tail !== undefined && window.offset === undefined && window.limit === undefined) {
        if (head + tail >= total) return render(0, total).join('\n');
        return [...render(0, head), `... omitted ${total - head - tail} line(s) ...`, ...render(total - tail, total)].join('\n');
    }

    let from: number;
    let to: number;
    if (window.offset !== undefined || window.limit !== undefined) {
        from = Math.max(0, (window.offset ?? 1) - 1);
        to = Math.min(total, from + (window.limit ?? DEFAULT_READ_LINES));
    } else if (tail !== undefined) {
        from = Math.max(0, total - tail);
        to = total;
    } else {
        from = 0;
        to = Math.min(total, head ?? DEFAULT_READ_LINES);
    }

    if (total === 0) return '';
    if (from >= total) return `[The file has ${total} line(s); offset ${from + 1} is past the end.]`;
    // A whole, unnumbered file comes back exactly as stored.
    if (!lineNumbers && from === 0 && to === total && !lines.some(line => line.length > MAX_LINE_CHARS)) return text;

    const body = render(from, to).join('\n');
    if (from === 0 && to === total) return body;
    const next = to < total ? ` Use offset: ${to + 1} to continue.` : '';
    return `${body}\n\n[Showing lines ${from + 1}-${to} of ${total}.${next}]`;
}

/** File-name filter for content search: `*.ts`, `*.{ts,vue}`, or a path glob such as `src/**\/*.test.ts`. */
export function fileGlobToRegExp(glob: string): { regex: RegExp; matchPath: boolean } {
    let source = '';
    let braceDepth = 0;
    for (let index = 0; index < glob.length; index++) {
        const char = glob[index];
        if (char === '*' && glob[index + 1] === '*') {
            source += '.*';
            index++;
            if (glob[index + 1] === '/') index++;
        } else if (char === '*') source += '[^/]*';
        else if (char === '?') source += '[^/]';
        else if (char === '{') { source += '(?:'; braceDepth++; }
        else if (char === '}' && braceDepth > 0) { source += ')'; braceDepth--; }
        else if (char === ',' && braceDepth > 0) source += '|';
        else source += char.replace(/[.+^$()|[\]\\{}]/g, '\\$&');
    }
    const matchPath = glob.includes('/');
    return { regex: new RegExp(matchPath ? `(^|/)${source}$` : `^${source}$`, 'i'), matchPath };
}

export interface GrepMatchBlock {
    /** 1-based line numbers that matched, at most `maxMatches`. */
    matches: number[];
    /** More lines matched after the last one returned. */
    more: boolean;
    /** Rendered lines: `12: text` for matches, `13- text` for context, `--` between gaps. */
    lines: string[];
}

/** Find matching lines in one file, with optional context, up to `maxMatches`. */
export function grepText(text: string, regex: RegExp, context: number, maxMatches: number, maxLineChars = 300): GrepMatchBlock {
    const lines = splitLines(text);
    const matches: number[] = [];
    let more = false;
    for (let index = 0; index < lines.length; index++) {
        if (!regex.test(lines[index])) continue;
        if (matches.length === maxMatches) {
            more = true;
            break;
        }
        matches.push(index + 1);
    }
    const rendered: string[] = [];
    let lastShown = 0;
    for (const lineNumber of matches) {
        const from = Math.max(lastShown + 1, lineNumber - context);
        if (lastShown > 0 && from > lastShown + 1) rendered.push('--');
        for (let current = from; current <= Math.min(lines.length, lineNumber + context); current++) {
            if (current <= lastShown) continue;
            const marker = matches.includes(current) ? ':' : '-';
            rendered.push(`${current}${marker} ${clipLine(lines[current - 1], maxLineChars)}`);
            lastShown = current;
        }
    }
    return { matches, more, lines: rendered };
}

export interface FileEdit {
    oldText: string;
    newText: string;
    replaceAll?: boolean;
}

export type FileEditConflictReason = 'expected_context_not_found' | 'ambiguous_context' | 'invalid_patch';

export type FileEditApplication =
    | { status: 'success'; content: string; replacements: number }
    | { status: 'conflict'; reason: FileEditConflictReason; editIndex: number; matchCount: number; lines?: number[]; message: string };

function lineNumberAt(content: string, offset: number): number {
    let line = 1;
    for (let index = content.indexOf('\n'); index !== -1 && index < offset; index = content.indexOf('\n', index + 1)) line++;
    return line;
}

/** Non-overlapping source ranges of `needle`, exact first, then tolerant of typographic variants. */
function findOccurrences(content: string, needle: string): Array<{ start: number; end: number }> {
    const exact: Array<{ start: number; end: number }> = [];
    for (let index = content.indexOf(needle); index !== -1; index = content.indexOf(needle, index + needle.length)) {
        exact.push({ start: index, end: index + needle.length });
    }
    if (exact.length) return exact;

    const haystack = normalizePatchText(content);
    const wanted = normalizePatchText(needle).text;
    if (!wanted) return [];
    const tolerant: Array<{ start: number; end: number }> = [];
    let previousEnd = 0;
    for (let index = haystack.text.indexOf(wanted); index !== -1; index = haystack.text.indexOf(wanted, index + 1)) {
        const end = index + wanted.length;
        if (index < previousEnd || !haystack.validBoundaries.has(index) || !haystack.validBoundaries.has(end)) continue;
        tolerant.push({ start: haystack.sourceOffsets[index], end: haystack.sourceOffsets[end] });
        previousEnd = end;
    }
    return tolerant;
}

/** Lines where the first non-blank line of a missing oldText appears, to point the model at what to re-read. */
function firstLineHints(content: string, oldText: string): number[] {
    const first = oldText.split('\n').map(line => line.trim()).find(Boolean);
    if (!first) return [];
    return splitLines(content).flatMap((line, index) => line.trim() === first ? [index + 1] : []).slice(0, 5);
}

/**
 * Apply ordered exact-text replacements in memory. Each oldText must match one
 * place unless replaceAll is set; a conflict applies none of the edits. Text
 * uses the file's line endings, and matching falls back to tolerating
 * typographic quote, dash, space, and Unicode normalization variants.
 */
export function applyFileEdits(original: string, edits: FileEdit[]): FileEditApplication {
    const crlf = original.includes('\r\n');
    const toFileEol = (value: string) => {
        const lf = value.replace(/\r\n?/g, '\n');
        return crlf ? lf.replace(/\n/g, '\r\n') : lf;
    };
    let content = original;
    let replacements = 0;
    for (const [editIndex, edit] of edits.entries()) {
        const oldText = toFileEol(edit.oldText);
        const newText = toFileEol(edit.newText);
        if (!oldText) return { status: 'conflict', reason: 'invalid_patch', editIndex, matchCount: 0, message: 'oldText must not be empty. Use file_write to create a file.' };
        if (oldText === newText) return { status: 'conflict', reason: 'invalid_patch', editIndex, matchCount: 0, message: 'oldText and newText are identical.' };

        const occurrences = findOccurrences(content, oldText);
        if (occurrences.length === 0) {
            const lines = firstLineHints(content, edit.oldText);
            return {
                status: 'conflict',
                reason: 'expected_context_not_found',
                editIndex,
                matchCount: 0,
                ...(lines.length ? { lines } : {}),
                message: lines.length
                    ? `oldText was not found. Its first line appears at line(s) ${lines.join(', ')}, but the text after it differs; re-read that range with file_read offset and limit, then copy oldText exactly.`
                    : 'oldText was not found. Locate the code with file_grep or re-read the file with file_read, then copy oldText exactly (without line-number prefixes).',
            };
        }
        if (occurrences.length > 1 && !edit.replaceAll) {
            const lines = occurrences.slice(0, 10).map(({ start }) => lineNumberAt(content, start));
            return {
                status: 'conflict',
                reason: 'ambiguous_context',
                editIndex,
                matchCount: occurrences.length,
                lines,
                message: `oldText matches ${occurrences.length} places (lines ${lines.join(', ')}${occurrences.length > lines.length ? ', …' : ''}). Include more surrounding lines to make it unique, or set replaceAll: true to change every match.`,
            };
        }
        for (const { start, end } of [...occurrences].reverse()) {
            content = content.slice(0, start) + newText + content.slice(end);
        }
        replacements += occurrences.length;
    }
    return { status: 'success', content, replacements };
}

/** A unified diff with three lines of context, capped so a large rewrite cannot flood the context. */
export function compactDiff(filePath: string, original: string, updated: string): string {
    const patch = createTwoFilesPatch(filePath, filePath, original.replace(/\r\n/g, '\n'), updated.replace(/\r\n/g, '\n'), '', '', { context: 3 })
        .split('\n')
        .filter(line => !line.startsWith('====='))
        .join('\n')
        .trimEnd();
    return patch.length > MAX_DIFF_CHARS
        ? `${patch.slice(0, MAX_DIFF_CHARS)}\n… [diff truncated at ${MAX_DIFF_CHARS} characters]`
        : patch;
}
