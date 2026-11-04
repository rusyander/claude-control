import { describe, expect, it } from 'vitest';
import { settleUnload } from './hold.ts';

// Снятие удержания: «выгрузка не доказана» маршрутизатором — не утечка, только если и дерево
// сервера снято, и память карты вернулась. Одного из двух мало: модель могла остаться в карте.
describe('settleUnload — unproven unload becomes a fact only with both proofs', () => {
  const leak = { rid: 'm1', reason: 'unload unproven: router gone before /models/unload' };
  const tree = { rid: 's1', fact: 'tree stopped: 2 pids' };
  const vram = { rid: 'g1', fact: 'vram back: 1442 MiB' };

  it('tree stopped + vram back → the leak turns into a verified fact', () => {
    const settled = settleUnload({ verified: [tree, vram], leaks: [leak] });
    expect(settled.leaks).toEqual([]);
    expect(settled.verified.at(-1)?.fact).toContain('vram back');
    expect(settled.verified.at(-1)?.rid).toBe('m1');
  });

  it('vram not proven back → the leak stays', () => {
    const settled = settleUnload({ verified: [tree], leaks: [leak] });
    expect(settled.leaks).toEqual([leak]);
  });

  it('tree not proven stopped → the leak stays', () => {
    expect(settleUnload({ verified: [vram], leaks: [leak] }).leaks).toEqual([leak]);
  });

  it('other leaks are never settled', () => {
    const other = { rid: 'x', reason: 'vram not back: 9000 MiB' };
    expect(settleUnload({ verified: [tree, vram], leaks: [other] }).leaks).toEqual([other]);
  });
});
