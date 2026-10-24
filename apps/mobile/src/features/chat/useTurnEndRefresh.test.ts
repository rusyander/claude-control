import { describe, expect, it } from 'vitest';
import { turnEndUnseen } from './useTurnEndRefresh';

/**
 * Когда экран разговора сам перечитывает транскрипт по отметке конца хода.
 * Отметку ставит стор прогонов (`lifecycle.sync.test.ts`); здесь — что экран
 * с ней делает, без двойного перечитывания там, где хватает перехода
 * «работает → закончил».
 */
describe('перечитать ленту по отметке конца хода', () => {
  it('ход, подхваченный уже законченным: «работает» не было — перечитать', () => {
    expect(turnEndUnseen({ key: 's1', running: false }, 's1', 10, false)).toBe(true);
  });

  it('новый ход сменил прошлый без остановки: прогон идёт, отметка новая — перечитать', () => {
    expect(turnEndUnseen({ key: 's1', at: 5, running: true }, 's1', 10, true)).toBe(true);
  });

  it('обычный конец «работает → закончил» — его перечитывает экран, второго запроса нет', () => {
    expect(turnEndUnseen({ key: 's1', running: true }, 's1', 10, false)).toBe(false);
  });

  it('отметка та же или её нет — ничего', () => {
    expect(turnEndUnseen({ key: 's1', at: 10, running: false }, 's1', 10, false)).toBe(false);
    expect(turnEndUnseen({ key: 's1', at: 10, running: false }, 's1', undefined, false)).toBe(
      false,
    );
  });

  it('переход в другой разговор — не конец хода', () => {
    expect(turnEndUnseen({ key: 's1', at: 5, running: false }, 's2', 10, false)).toBe(false);
  });
});
