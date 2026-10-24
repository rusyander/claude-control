import { describe, expect, it } from 'vitest';
import {
  codexShellAsk,
  gooseShellAsk,
  opencodeShellAsk,
  qwenShellAsk,
  unwrapShellLine,
} from './shell-ask.ts';

/**
 * Команда оболочки с провода просьбы чужого CLI (формы — живые пробы 24.10,
 * `provider-formats-live.agent.md`). Судья читает ровно то, что исполнит оболочка:
 * обёртка снята, кавычки раскрыты, оболочка названа или `unknown`.
 */
describe('shell-ask: команда с провода чужого CLI', () => {
  it('строка запуска: pwsh -Command, bash -lc, cmd /c — команда без обёртки и оболочка', () => {
    expect(
      unwrapShellLine(`"C:\\Program Files\\PowerShell\\7\\pwsh.exe" -Command 'git branch -D old'`),
    ).toEqual({ command: 'git branch -D old', shell: 'powershell' });
    expect(unwrapShellLine(`powershell.exe -NoProfile -Command 'it''s here'`)).toEqual({
      command: "it's here",
      shell: 'powershell',
    });
    expect(unwrapShellLine(`/bin/bash -lc 'echo '\\''x'\\'' && git push'`)).toEqual({
      command: "echo 'x' && git push",
      shell: 'bash',
    });
    expect(unwrapShellLine('/usr/bin/zsh -c "pnpm build"')).toEqual({
      command: 'pnpm build',
      shell: 'bash',
    });
    expect(unwrapShellLine('C:\\Windows\\System32\\cmd.exe /c rd /s /q src')).toEqual({
      command: 'rd /s /q src',
      shell: 'cmd',
    });
    // Обёртку не узнали — строка как есть: судья прочтёт её обоими чтениями.
    expect(unwrapShellLine('git push origin main')).toEqual({
      command: 'git push origin main',
      shell: 'unknown',
    });
    expect(unwrapShellLine('pwsh -NoProfile')).toEqual({
      command: 'pwsh -NoProfile',
      shell: 'unknown',
    });
  });

  it('codex: строка app-server и список старого execCommandApproval, каталог из cwd', () => {
    expect(
      codexShellAsk({ command: `/bin/bash -lc 'git tag -d v1'`, cwd: '/work/copy', itemId: 'i' }),
    ).toEqual({ command: 'git tag -d v1', shell: 'bash', cwd: '/work/copy' });
    expect(codexShellAsk({ command: ['pwsh', '-Command', 'Remove-Item -Recurse x'] })).toEqual({
      command: 'Remove-Item -Recurse x',
      shell: 'powershell',
    });
    expect(codexShellAsk({ command: ['git', 'push', 'origin', 'main'] })).toEqual({
      command: 'git push origin main',
      shell: 'unknown',
    });
    expect(codexShellAsk({ reason: 'нет команды' })).toBeUndefined();
    expect(codexShellAsk({ command: '   ' })).toBeUndefined();
  });

  it('qwen: только run_shell_command; оболочка — bash на POSIX, не названа на Windows', () => {
    const call = (toolName: string) => ({
      _meta: { toolName },
      rawInput: { command: 'git branch -D old', directory: '/work/copy' },
    });
    expect(qwenShellAsk(call('run_shell_command'), 'linux')).toEqual({
      command: 'git branch -D old',
      shell: 'bash',
      cwd: '/work/copy',
    });
    expect(qwenShellAsk(call('run_shell_command'), 'win32')?.shell).toBe('unknown');
    // Правка файла — не команда: решает переключатель, как раньше.
    expect(qwenShellAsk(call('write_file'), 'linux')).toBeUndefined();
    expect(qwenShellAsk({ _meta: { toolName: 'run_shell_command' } }, 'linux')).toBeUndefined();
  });

  it('goose: только инструмент shell; у прочих инструментов command — не строка запуска', () => {
    expect(
      gooseShellAsk({ title: 'shell · git push', rawInput: { command: 'git push' } }, 'darwin'),
    ).toEqual({ command: 'git push', shell: 'bash' });
    expect(
      gooseShellAsk({ title: 'developer__shell', rawInput: { command: 'ls' } }, 'win32'),
    ).toEqual({ command: 'ls', shell: 'unknown' });
    // Без заголовка — по полю команды (ранние версии заголовок не слали).
    expect(gooseShellAsk({ rawInput: { command: 'ls' } }, 'linux')).toEqual({
      command: 'ls',
      shell: 'bash',
    });
    expect(
      gooseShellAsk({ title: 'text_editor', rawInput: { command: 'str_replace' } }, 'linux'),
    ).toBeUndefined();
    expect(gooseShellAsk({ title: 'shell' }, 'linux')).toBeUndefined();
  });

  it('opencode: просьба bash, звенья из patterns — одной строкой, судятся все', () => {
    expect(
      opencodeShellAsk(
        { permission: 'bash', patterns: ['pnpm build', 'git branch -D old'] },
        'linux',
      ),
    ).toEqual({ command: 'pnpm build\ngit branch -D old', shell: 'bash' });
    expect(opencodeShellAsk({ permission: 'edit', patterns: ['a.ts'] }, 'linux')).toBeUndefined();
    expect(opencodeShellAsk({ permission: 'bash', patterns: ['', 1] }, 'linux')).toBeUndefined();
    expect(opencodeShellAsk({ permission: 'bash' }, 'linux')).toBeUndefined();
  });
});
