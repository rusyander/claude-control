import { describe, it, expect } from 'vitest';
import {
  applyCodexHooks,
  CODEX_HOOK_EVENTS,
  isValidCodexTimeout,
  readCodexHooks,
} from './codex-hook.ts';

/**
 * Хуки Codex — `hooks.json` формы Claude/Qwen со своим словарём событий (MAP 26).
 *
 * Разбор общий с Qwen и проверен там; здесь — только то, чем Codex отличается и
 * что сверено живым `hooks/list`: двенадцать событий, свой словарь (событие Qwen
 * `Notification` у Codex чужое), таймаут в секундах с потолком панели.
 */
describe('Codex: hooks.json', () => {
  it('двенадцать событий; у SessionEnd и Interrupt свой потолок 3 с', () => {
    expect(CODEX_HOOK_EVENTS).toHaveLength(12);
    const limited = CODEX_HOOK_EVENTS.filter((event) => event.timeoutMax !== undefined);
    expect(limited.map((event) => [event.name, event.timeoutMax, event.timeoutDefault])).toEqual([
      ['SessionEnd', 3, 1],
      ['Interrupt', 3, 1],
    ]);
  });

  it('таймаут — целые секунды 1–3600', () => {
    expect(isValidCodexTimeout(1)).toBe(true);
    expect(isValidCodexTimeout(3600)).toBe(true);
    expect(isValidCodexTimeout(0)).toBe(false);
    expect(isValidCodexTimeout(3601)).toBe(false);
    expect(isValidCodexTimeout(1.5)).toBe(false);
    expect(isValidCodexTimeout('30')).toBe(false);
  });

  it('событие из словаря Qwen, которого нет у Codex, сохраняется, а не правится', () => {
    const state = readCodexHooks({
      Notification: [{ hooks: [{ type: 'command', command: 'a' }] }],
      Interrupt: [{ hooks: [{ type: 'command', command: 'b', timeout: 2 }] }],
    });
    expect(state.rules).toEqual([{ event: 'Interrupt', command: 'b', timeout: 2 }]);
    expect(state.preservedEvents.map((entry) => entry.key)).toEqual(['Notification']);
  });

  it('таймаут вне границ Codex делает событие несопровождаемым', () => {
    const state = readCodexHooks({
      Stop: [{ hooks: [{ type: 'command', command: 'a', timeout: 60000 }] }],
    });
    expect(state.rules).toEqual([]);
    expect(state.preservedEvents.map((entry) => entry.key)).toEqual(['Stop']);
  });

  it('сборка пишет `timeout`, а не `timeoutSec`, и пустой список убирает ключ', () => {
    const written = applyCodexHooks(undefined, [
      { event: 'PreToolUse', matcher: '^Bash$', command: 'x', timeout: 30 },
    ]);
    expect(written).toEqual({
      PreToolUse: [{ matcher: '^Bash$', hooks: [{ type: 'command', command: 'x', timeout: 30 }] }],
    });
    expect(applyCodexHooks(written, [])).toBeUndefined();
  });
});
