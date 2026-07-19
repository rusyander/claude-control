import { describe, it, expect } from 'vitest';
import { readDecision, scriptCommand, EVENT_FIXTURES } from './HookProbe.ts';

/**
 * Тесты разбора решения хука. Стенд обязан понимать оба способа, которыми
 * хук сообщает вердикт: старый (код выхода 2) и новый (JSON с
 * permissionDecision). Аудит нашёл, что вторая ветка работала не сразу, —
 * поэтому она закреплена тестами.
 */
describe('HookProbe.readDecision', () => {
  it('код выхода 2 — это блокировка', () => {
    expect(readDecision(2, undefined).decision).toBe('block');
  });

  it('permissionDecision "deny" — блокировка', () => {
    const parsed = { hookSpecificOutput: { permissionDecision: 'deny' } };
    expect(readDecision(0, parsed).decision).toBe('block');
  });

  it('permissionDecision "ask" — запрос подтверждения', () => {
    const parsed = { hookSpecificOutput: { permissionDecision: 'ask' } };
    expect(readDecision(0, parsed).decision).toBe('ask');
  });

  it('permissionDecision "allow" — пропуск', () => {
    const parsed = { hookSpecificOutput: { permissionDecision: 'allow' } };
    expect(readDecision(0, parsed).decision).toBe('pass');
  });

  it('пустой ответ и код 0 — пропуск', () => {
    expect(readDecision(0, undefined).decision).toBe('pass');
  });

  it('continue:false — блокировка со stopReason', () => {
    const result = readDecision(0, { continue: false, stopReason: 'нельзя' });
    expect(result.decision).toBe('block');
    expect(result.reason).toBe('нельзя');
  });

  it('переносит пояснение и добавленный контекст', () => {
    const parsed = {
      hookSpecificOutput: {
        permissionDecision: 'ask',
        permissionDecisionReason: 'опасно',
        additionalContext: 'подсказка',
      },
    };
    const result = readDecision(0, parsed);
    expect(result.reason).toBe('опасно');
    expect(result.addedContext).toBe('подсказка');
  });
});

describe('HookProbe.scriptCommand', () => {
  it('несуществующий файл — пустая команда', () => {
    expect(scriptCommand('C:/nope/missing.mjs')).toBe('');
  });
});

describe('EVENT_FIXTURES', () => {
  it('каждая заготовка несёт имя события в payload', () => {
    for (const fixture of EVENT_FIXTURES) {
      expect(fixture.payload.hook_event_name).toBe(fixture.event);
    }
  });

  it('есть заготовки и на срабатывание, и на пропуск', () => {
    expect(EVENT_FIXTURES.some((f) => f.expectsBlock)).toBe(true);
    expect(EVENT_FIXTURES.some((f) => !f.expectsBlock)).toBe(true);
  });
});
