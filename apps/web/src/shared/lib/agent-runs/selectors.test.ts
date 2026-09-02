import { describe, it, expect } from 'vitest';
import { selectActiveRuns, countRunning, type RunLike } from './selectors';
import { STALL_MS } from './status';

/**
 * Тесты выборок для пульта агентов. Тест-кейсы см. .agent/TEST-CASES.md →
 * «Пульт агентов (выборки)».
 */
const NOW = 1_000_000;

function run(partial: Partial<RunLike> & { id: string }): RunLike {
  return { status: 'idle', lastEventAt: NOW, ...partial };
}

describe('selectActiveRuns', () => {
  it('отсеивает завершённые (idle)', () => {
    const active = selectActiveRuns([run({ id: 'a', status: 'idle' })], NOW);
    expect(active).toEqual([]);
  });

  it('оставляет работающие/молчащие/ждущие/упавшие и сортирует по тревожности', () => {
    const active = selectActiveRuns(
      [
        run({ id: 'r', status: 'running', projectPath: 'C:/r' }),
        run({ id: 'q', status: 'running', lastEventAt: NOW - STALL_MS - 1, projectPath: 'C:/q' }),
        run({ id: 'w', status: 'waiting', projectPath: 'C:/w' }),
        run({ id: 'e', status: 'error', projectPath: 'C:/e' }),
      ],
      NOW,
    );
    expect(active.map((a) => a.id)).toEqual(['e', 'w', 'q', 'r']);
  });

  it('молчащий работающий становится quiet, а не error', () => {
    const active = selectActiveRuns(
      [run({ id: 'stuck', status: 'running', lastEventAt: NOW - STALL_MS - 1 })],
      NOW,
    );
    expect(active[0]?.status).toBe('quiet');
  });
});

describe('countRunning', () => {
  it('считает работающих вместе с молчащими: процесс жив в обоих случаях', () => {
    const runs = [
      run({ id: 'a', status: 'running' }),
      run({ id: 'b', status: 'running', lastEventAt: NOW - STALL_MS - 1 }), // молчит → всё ещё работает
      run({ id: 'c', status: 'waiting' }),
      run({ id: 'd', status: 'idle' }),
    ];
    expect(countRunning(runs, NOW)).toBe(2);
  });
});
