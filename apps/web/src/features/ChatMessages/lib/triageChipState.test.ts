import { describe, it, expect } from 'vitest';
import { triageChipState } from './triageChipState';

/**
 * Подпись итога разбора в хабе. Проверяется ровно то, чем она может соврать:
 * разбор, убитый перезапуском панели, не должен читаться как «группы пошли».
 */
describe('triageChipState', () => {
  it('записи разбора ещё нет, прогон идёт — «идёт разбор»', () => {
    expect(triageChipState(undefined, true)).toBe('running');
  });

  it('записи разбора нет и прогон НЕ идёт — «разбор не идёт», а не «идёт»', () => {
    expect(triageChipState(undefined, false)).toBe('stopped');
  });

  it('блок применён', () => {
    expect(triageChipState({ at: 'now', received: true, repairs: [], conflicts: [] }, false)).toBe(
      'applied',
    );
  });

  it('блока в ответе не было — группы пошли как предложено', () => {
    expect(triageChipState({ at: 'now', received: false, repairs: [], conflicts: [] }, false)).toBe(
      'missing',
    );
  });

  it('разбор оборван перезапуском — состояние своё: группы стоят на вопросе', () => {
    expect(
      triageChipState(
        {
          at: 'now',
          received: false,
          interrupted: true,
          repairs: [],
          conflicts: [],
        },
        false,
      ),
    ).toBe('interrupted');
  });
});
