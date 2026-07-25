import { describe, it, expect } from 'vitest';
import { UnrecognizedFormatError } from './codex-toml.ts';
import { applyQwenHooks, readQwenHooks, QWEN_HOOK_EVENTS } from './qwen-hook.ts';

/**
 * Хуки Qwen Code — ключ КОРНЯ `hooks` в settings.json (QWEN-1).
 *
 * Проверяем то, ради чего адаптер и написан: панель ведёт только знакомую форму
 * (группа с одним действием типа `command`), всё остальное сохраняет нетронутым,
 * а пустой результат УДАЛЯЕТ ключ, а не пишет пустой объект.
 */
describe('Qwen: ключ hooks в settings.json', () => {
  const hooks = {
    PreToolUse: [
      { matcher: '^Bash$', hooks: [{ type: 'command', command: './check.sh', timeout: 5000 }] },
    ],
    Stop: [{ hooks: [{ type: 'command', command: 'notify-send done' }] }],
  };

  it('читает правила: матчер, команда, таймаут', () => {
    const state = readQwenHooks(hooks);
    expect(state.present).toBe(true);
    expect(state.rules).toEqual([
      { event: 'PreToolUse', matcher: '^Bash$', command: './check.sh', timeout: 5000 },
      { event: 'Stop', command: 'notify-send done' },
    ]);
    expect(state.preservedEvents).toEqual([]);
  });

  it('ключа нет — правил нет, и это не ошибка', () => {
    expect(readQwenHooks(undefined)).toEqual({ present: false, rules: [], preservedEvents: [] });
  });

  it('не объект — fail-closed', () => {
    expect(() => readQwenHooks([])).toThrow(UnrecognizedFormatError);
    expect(() => readQwenHooks('x')).toThrow(UnrecognizedFormatError);
  });

  it('незнакомая форма делает НЕСОПРОВОЖДАЕМЫМ всё событие целиком', () => {
    const cases: Record<string, unknown> = {
      // Два действия в одной группе.
      PreToolUse: [
        {
          hooks: [
            { type: 'command', command: 'a' },
            { type: 'command', command: 'b' },
          ],
        },
      ],
      // Тип действия не command.
      PostToolUse: [{ hooks: [{ type: 'http', url: 'https://example.test' }] }],
      // Чужое поле группы.
      Stop: [{ sequential: true, hooks: [{ type: 'command', command: 'a' }] }],
      // Чужое поле действия.
      SessionEnd: [{ hooks: [{ type: 'command', command: 'a', async: true }] }],
      // Событие вне задокументированного списка.
      SomethingNew: [{ hooks: [{ type: 'command', command: 'a' }] }],
      // Значение события — не массив.
      Notification: { hooks: [] },
    };

    const state = readQwenHooks(cases);
    expect(state.rules).toEqual([]);
    expect(state.preservedEvents.map((entry) => entry.key)).toEqual(Object.keys(cases));
  });

  it('пустой матчер и «*» читаются как «матчера нет»', () => {
    const state = readQwenHooks({
      PreToolUse: [
        { matcher: '', hooks: [{ type: 'command', command: 'a' }] },
        { matcher: '   ', hooks: [{ type: 'command', command: 'b' }] },
      ],
    });
    expect(state.rules.every((rule) => rule.matcher === undefined)).toBe(true);
  });

  it('запись: правила собираются в задокументированную форму', () => {
    const next = applyQwenHooks(undefined, [
      { event: 'PreToolUse', matcher: '^Bash$', command: './a.sh', timeout: 1000 },
      { event: 'PreToolUse', command: './b.sh' },
    ]);
    expect(next).toEqual({
      PreToolUse: [
        { matcher: '^Bash$', hooks: [{ type: 'command', command: './a.sh', timeout: 1000 }] },
        { hooks: [{ type: 'command', command: './b.sh' }] },
      ],
    });
    // Круг замкнулся: то, что записали, читается тем же адаптером.
    expect(readQwenHooks(next).rules).toEqual([
      { event: 'PreToolUse', matcher: '^Bash$', command: './a.sh', timeout: 1000 },
      { event: 'PreToolUse', command: './b.sh' },
    ]);
  });

  it('пустой список УДАЛЯЕТ ключ, а не пишет {}', () => {
    expect(applyQwenHooks(hooks, [])).toBeUndefined();
  });

  it('несопровождаемое событие переживает запись и не даёт себя переписать', () => {
    const file = {
      PreToolUse: [{ sequential: true, hooks: [{ type: 'command', command: 'keep' }] }],
      Stop: [{ hooks: [{ type: 'command', command: 'old' }] }],
    };

    const next = applyQwenHooks(file, [{ event: 'Stop', command: 'new' }]);
    expect(next?.PreToolUse).toEqual(file.PreToolUse);
    expect(next?.Stop).toEqual([{ hooks: [{ type: 'command', command: 'new' }] }]);

    // Черновик, называющий несопровождаемое событие, — отказ.
    expect(() => applyQwenHooks(file, [{ event: 'PreToolUse', command: 'x' }])).toThrow(
      UnrecognizedFormatError,
    );
  });

  it('порядок ключей сохраняется: сначала бывшие в файле, потом новые', () => {
    const next = applyQwenHooks({ Stop: [], PreToolUse: [] }, [
      { event: 'PreToolUse', command: 'a' },
      { event: 'SessionStart', command: 'b' },
      { event: 'Stop', command: 'c' },
    ]);
    expect(Object.keys(next ?? {})).toEqual(['Stop', 'PreToolUse', 'SessionStart']);
  });

  it('словарь событий: матчер есть не у всех', () => {
    const byName = new Map(QWEN_HOOK_EVENTS.map((event) => [event.name, event.supportsMatcher]));
    expect(byName.get('PreToolUse')).toBe(true);
    expect(byName.get('UserPromptSubmit')).toBe(false);
    expect(byName.get('TodoCompleted')).toBe(false);
  });
});
