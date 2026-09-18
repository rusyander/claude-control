import { describe, it, expect } from 'vitest';
import { triageChipState } from './triageChipState';

/**
 * Подпись итога разбора в хабе. Проверяется ровно то, чем она может соврать:
 * разбор, убитый перезапуском панели, не должен читаться как «группы пошли».
 */
describe('triageChipState', () => {
  it('записи разбора ещё нет — он идёт', () => {
    expect(triageChipState(undefined)).toBe('running');
  });

  it('блок применён', () => {
    expect(triageChipState({ at: 'now', received: true, repairs: [], conflicts: [] })).toBe(
      'applied',
    );
  });

  it('блока в ответе не было — группы пошли как предложено', () => {
    expect(triageChipState({ at: 'now', received: false, repairs: [], conflicts: [] })).toBe(
      'missing',
    );
  });

  it('разбор оборван перезапуском — состояние своё: группы стоят на вопросе', () => {
    expect(
      triageChipState({
        at: 'now',
        received: false,
        interrupted: true,
        repairs: [],
        conflicts: [],
      }),
    ).toBe('interrupted');
  });
});
