import { describe, expect, it } from 'vitest'
import { findBlockedShellCommand, type ShellGuardOptions } from './shell-guard.js'

const posix: ShellGuardOptions = {
    cwd: '/srv/projects/app',
    platform: 'linux',
    homeDir: '/home/alex',
    env: {},
    protectedPaths: ['/srv/projects/app', '/home/alex/.config/cynosure'],
}
const windows: ShellGuardOptions = {
    cwd: 'C:\\projects\\app',
    platform: 'win32',
    homeDir: 'C:\\Users\\alex',
    env: {},
    protectedPaths: ['C:\\projects\\app'],
}

const blocked = (command: string, options = posix) => findBlockedShellCommand(command, options)

describe('shell safety guard', () => {
    it.each([
        'rm -rf /',
        'rm -rf /*',
        'rm -fr ~',
        'rm -r -f ~/',
        'rm --recursive --force $HOME',
        'rm -rf "${HOME}"/*',
        'rm -rf /home/alex',
        'rm -rf /usr',
        'rm -rf /etc/',
        'rm -rf /us*',
        'rm -rf --no-preserve-root /',
        'rm -rf .',
        'rm -rf *',
        'rm -rf ./*',
        'rm -rf ..',
        'rm -rf ../../../..',
        'rm -rf /srv',
        'rm -rf /home/alex/.config',
        'rm -rf $UNSET_DIR/',
        'rm -rf "$UNSET_DIR"/*',
        'sudo rm -rf /',
        'sudo -u root rm -rf /var',
        '/bin/rm -rf /',
        '\\rm -rf /',
        'env FOO=1 nice -n 5 rm -rf /',
        'timeout 10 rm -rf /',
        'echo hi && rm -rf ~',
        'ls; rm -rf /',
        'false || rm -rf /',
        'echo $(rm -rf /)',
        'bash -c "rm -rf /"',
        'sh -lc \'cd / && rm -rf *\'',
        'eval "rm -rf ~"',
        'cd / && rm -rf usr',
        'cd ~ && rm -rf *',
        'TARGET=/; rm -rf $TARGET',
        'mkfs.ext4 /dev/sda1',
        'wipefs -a /dev/sda',
        'dd if=/dev/zero of=/dev/sda bs=1M',
        'cat image.iso > /dev/nvme0n1',
        'shred -n 3 /dev/sda',
        ':(){ :|:& };:',
        'shutdown -h now',
        'sudo reboot',
        'systemctl poweroff',
        'init 0',
        'kill -9 -1',
        'chmod -R 777 /',
        'chown -R nobody /etc',
        'chgrp -R users ~',
        'mv /etc /tmp/etc',
        'mv ~ /tmp/backup',
    ])('blocks %s', (command) => {
        expect(blocked(command)).toEqual(expect.any(String))
    })

    it.each([
        'ls -la /',
        'rm file.txt',
        'rm -rf node_modules',
        'rm -rf ./dist',
        'rm -rf dist/*',
        'rm -rf /tmp/build',
        'rm -rf ~/.cache/pip',
        'rm -rf $HOME/.npm/_cacache',
        'rm -rf /srv/projects/app/coverage',
        'rm ~/*.log',
        'rm -rf "$UNSET_DIR/build"',
        'OUT=dist; rm -rf "$OUT"/*',
        'cd dist && rm -rf *',
        'cd /tmp/work && rm -rf .',
        'echo "rm -rf /"',
        'grep -r "rm -rf /" .',
        'git commit -m "never run rm -rf /"',
        'cat /dev/sda1 | head -c 512 | xxd',
        'dd if=/dev/zero of=./disk.img bs=1M count=10',
        'echo hi > /dev/null 2>&1',
        'ls >&2',
        'chmod -R u+w .',
        'chmod 755 /usr/local/bin/tool',
        'mv build dist',
        'kill -1 1234',
        'kill -9 4321',
        'find . -name "*.pyc" -delete',
        'systemctl status nginx',
        'npm run build && npm test',
    ])('allows %s', (command) => {
        expect(blocked(command)).toBeNull()
    })

    it('blocks deleting the working directory only when it is protected', () => {
        expect(blocked('rm -rf .', { ...posix, cwd: '/tmp/scratch' })).toBeNull()
        expect(blocked('rm -rf .', { ...posix, cwd: '/srv/projects/app' })).toMatch(/\/srv\/projects\/app/)
    })

    it('explains what would be deleted', () => {
        expect(blocked('rm -rf ~/*')).toBe('it recursively deletes ~/* (/home/alex)')
    })

    it('uses the server environment for variables the script does not set', () => {
        expect(blocked('rm -rf $WORKSPACE', { ...posix, env: { WORKSPACE: '/srv/projects/app' } })).toEqual(expect.any(String))
        expect(blocked('rm -rf $TMPDIR/build', { ...posix, env: { TMPDIR: '/tmp' } })).toBeNull()
    })

    it.each([
        'rd /s /q C:\\',
        'rmdir /S /Q C:\\Windows',
        'del /s /q C:\\*',
        'del /s /q %USERPROFILE%',
        'Remove-Item -Recurse -Force C:\\Users',
        'rm -Recurse -Force $env:USERPROFILE',
        'powershell -Command "Remove-Item -Recurse -Force C:\\"',
        'cmd /c rd /s /q C:\\projects',
        'format C:',
        'Format-Volume -DriveLetter D',
        'Stop-Computer -Force',
        'shutdown /s /t 0',
    ])('blocks %s on Windows', (command) => {
        expect(blocked(command, windows)).toEqual(expect.any(String))
    })

    it.each([
        'dir C:\\',
        'rd /s /q C:\\projects\\app\\build',
        'del /q C:\\projects\\app\\*.log',
        'Remove-Item -Recurse -Force .\\node_modules',
        'Get-ChildItem -Recurse C:\\Users\\alex\\Documents',
    ])('allows %s on Windows', (command) => {
        expect(blocked(command, windows)).toBeNull()
    })
})
