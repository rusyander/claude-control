import { describe, it, expect } from 'vitest';
import { parseToolArgs } from './parseToolArgs';

const t = (key: string): string => key;

/**
 * Главное здесь — что сломанный JSON НЕ становится пустым объектом. Именно так
 * было раньше: вызов уходил с `{}`, инструмент отвечал на умолчаниях, и панель
 * рисовала зелёный успех на параметры, которых никто не отправлял.
 */
describe('parseToolArgs', () => {
  it('лишняя запятая — ошибка с позицией, а не пустой вызов', () => {
    const result = parseToolArgs('{"query": "foo",}', t);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    // Причина от JSON.parse обязана дойти: без неё опечатку не найти.
    expect(result.error.startsWith('sandbox.argumentsInvalid: ')).toBe(true);
    expect(result.error.length).toBeGreaterThan('sandbox.argumentsInvalid: '.length);
  });

  it('пустое поле — это «параметров нет», а не ошибка', () => {
    expect(parseToolArgs('   ', t)).toEqual({ ok: true, args: {} });
  });

  it('правильный объект доезжает как есть', () => {
    expect(parseToolArgs('{"query": "foo"}', t)).toEqual({ ok: true, args: { query: 'foo' } });
  });

  it('массив разбирается, но параметрами инструмента не является', () => {
    expect(parseToolArgs('[1, 2]', t)).toEqual({ ok: false, error: 'sandbox.argumentsNotObject' });
  });

  it('число и null тоже отбиваются', () => {
    expect(parseToolArgs('42', t)).toEqual({ ok: false, error: 'sandbox.argumentsNotObject' });
    expect(parseToolArgs('null', t)).toEqual({ ok: false, error: 'sandbox.argumentsNotObject' });
  });
});
