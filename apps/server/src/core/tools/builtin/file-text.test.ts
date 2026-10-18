import { describe, expect, it } from 'vitest';
import { applyFileEdits, compactDiff, fileGlobToRegExp, renderTextWindow } from './file-text.js';

describe('file text helpers', () => {
    it('keeps CRLF line endings when the model sends LF text', () => {
        const result = applyFileEdits('one\r\ntwo\r\nthree\r\n', [{ oldText: 'one\ntwo', newText: 'one\n1.5\ntwo' }]);

        expect(result).toMatchObject({ status: 'success', content: 'one\r\n1.5\r\ntwo\r\nthree\r\n' });
    });

    it('matches oldText that differs only in typographic quotes and dashes', () => {
        const result = applyFileEdits("const label = 'Don’t — stop'\n", [{ oldText: "'Don't - stop'", newText: "'Keep going'" }]);

        expect(result).toMatchObject({ status: 'success', content: "const label = 'Keep going'\n" });
    });

    it('rejects an edit that would change nothing', () => {
        expect(applyFileEdits('a\n', [{ oldText: 'a', newText: 'a' }])).toMatchObject({ status: 'conflict', reason: 'invalid_patch' });
    });

    it('shows only the changed hunk in diffs', () => {
        const lines = Array.from({ length: 40 }, (_, index) => `line ${index + 1}`);
        const updated = [...lines.slice(0, 20), 'inserted', ...lines.slice(20)];

        const diff = compactDiff('/x.txt', `${lines.join('\n')}\n`, `${updated.join('\n')}\n`);

        expect(diff).toContain('+inserted');
        expect(diff).not.toContain('line 1\n');
        expect(diff).not.toContain('line 40');
    });

    it('matches name and path globs', () => {
        expect(fileGlobToRegExp('*.{ts,vue}').regex.test('App.vue')).toBe(true);
        expect(fileGlobToRegExp('*.{ts,vue}').regex.test('App.tsx')).toBe(false);
        const pathGlob = fileGlobToRegExp('src/**/*.test.ts');
        expect(pathGlob.matchPath).toBe(true);
        expect(pathGlob.regex.test('/repo/src/core/a.test.ts')).toBe(true);
        expect(pathGlob.regex.test('/repo/src/a.test.ts')).toBe(true);
        expect(pathGlob.regex.test('/repo/lib/a.test.ts')).toBe(false);
    });

    it('reports an offset past the end of the file', () => {
        expect(renderTextWindow('a\nb\n', { offset: 9 })).toContain('offset 9 is past the end');
    });
});
