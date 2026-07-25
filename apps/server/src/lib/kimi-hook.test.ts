import { describe, it, expect } from 'vitest';
import { UnrecognizedFormatError } from './codex-toml.ts';
import { readKimiHooks, writeKimiHooks, KIMI_HOOK_EVENTS } from './kimi-hook.ts';

/**
 * Хуки Kimi Code — массив таблиц `[[hooks]]` в config.toml (KIMI-1).
 *
 * Главное, что проверяем: хирургическая правка (всё вне региона — байт-в-байт,
 * включая комментарии), закрытый список событий и границы таймаута, пустой
 * список УДАЛЯЕТ регион.
 */
describe('Kimi: [[hooks]] в config.toml', () => {
  const FILE = `# личный конфиг
default_permission_mode = "manual"

[[hooks]]
event = "PreToolUse"
matcher = "Bash"
command = "./check.sh"
timeout = 5

[mcp]
timeout_ms = 30000
`;

  it('читает правила', () => {
    expect(readKimiHooks(FILE)).toEqual([
      { event: 'PreToolUse', matcher: 'Bash', command: './check.sh', timeout: 5 },
    ]);
  });

  it('пустой файл и файл без хуков — пусто, не ошибка', () => {
    expect(readKimiHooks('')).toEqual([]);
    expect(readKimiHooks('default_permission_mode = "auto"\n')).toEqual([]);
  });

  it('fail-closed на всём, что не задокументировано', () => {
    const bad = [
      'hooks = 5\n',
      '[[hooks]]\ncommand = "x"\n', // нет события
      '[[hooks]]\nevent = "Unknown"\ncommand = "x"\n',
      '[[hooks]]\nevent = "Stop"\n', // нет команды
      '[[hooks]]\nevent = "Stop"\ncommand = ""\n',
      '[[hooks]]\nevent = "Stop"\ncommand = "x"\nasync = true\n', // чужое поле
      '[[hooks]]\nevent = "Stop"\ncommand = "x"\ntimeout = 0\n',
      '[[hooks]]\nevent = "Stop"\ncommand = "x"\ntimeout = 601\n',
    ];
    for (const text of bad) {
      expect(() => readKimiHooks(text), text).toThrow(UnrecognizedFormatError);
    }
  });

  it('пишет, сохраняя всё вне региона байт-в-байт', () => {
    const next = writeKimiHooks(FILE, [
      { event: 'Stop', command: 'notify-send done' },
      { event: 'PreToolUse', matcher: 'Bash', command: './check.sh', timeout: 10 },
    ]);

    expect(next).toContain('# личный конфиг');
    expect(next).toContain('default_permission_mode = "manual"');
    expect(next).toContain('timeout_ms = 30000');
    expect(readKimiHooks(next)).toEqual([
      { event: 'Stop', command: 'notify-send done' },
      { event: 'PreToolUse', matcher: 'Bash', command: './check.sh', timeout: 10 },
    ]);
  });

  it('пустой список УДАЛЯЕТ регион [[hooks]], прочее цело', () => {
    const next = writeKimiHooks(FILE, []);
    expect(next).not.toContain('[[hooks]]');
    expect(next).toContain('default_permission_mode = "manual"');
    expect(next).toContain('[mcp]');
    expect(readKimiHooks(next)).toEqual([]);
  });

  it('черновик с незадокументированным событием или таймаутом не пишется', () => {
    expect(() => writeKimiHooks(FILE, [{ event: 'Nope', command: 'x' }])).toThrow(
      UnrecognizedFormatError,
    );
    expect(() => writeKimiHooks(FILE, [{ event: 'Stop', command: 'x', timeout: 900 }])).toThrow(
      UnrecognizedFormatError,
    );
  });

  it('в непонятый файл не пишем вовсе (fail-closed на входе)', () => {
    const broken = '[[hooks]]\nevent = "Stop"\ncommand = "x"\nasync = true\n';
    expect(() => writeKimiHooks(broken, [{ event: 'Stop', command: 'y' }])).toThrow(
      UnrecognizedFormatError,
    );
  });

  it('список событий закрытый и содержит блокирующие', () => {
    expect(KIMI_HOOK_EVENTS).toContain('PreToolUse');
    expect(KIMI_HOOK_EVENTS).toContain('UserPromptSubmit');
    expect(KIMI_HOOK_EVENTS).toContain('Interrupt');
    expect(KIMI_HOOK_EVENTS).not.toContain('MessageDisplay');
  });
});
