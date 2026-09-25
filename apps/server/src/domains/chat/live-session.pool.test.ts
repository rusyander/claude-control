import { describe, it, expect } from 'vitest';
import { LiveSession, LiveSessionPool } from './live-session.ts';
import type { TransportOpener } from './live-transport.ts';

/**
 * Закрытие простаивающих процессов в папке (F4c): уборка копии группы и отмена
 * плана. Транспорт — в памяти: конец ввода закрывает «процесс» следующим тиком,
 * как CLI, дочитавший stdin.
 */
const memory: TransportOpener = (_launch, handlers) => ({
  pid: 1,
  write: () => undefined,
  end: () => void setTimeout(() => handlers.close(0), 5),
  kill: () => handlers.close(1),
  detach: () => undefined,
});

function session(pool: LiveSessionPool, id: string, cwd: string): LiveSession {
  const live = new LiveSession(
    { command: 'cli', args: [], cwd, env: {}, shell: false, signature: 's' },
    Date.now,
    memory,
  );
  live.sessionId = id;
  pool.keep(live);
  return live;
}

describe('LiveSessionPool.closeIdleIn', () => {
  it('закрывает простаивающих в папке и под ней, чужие папки не трогает', async () => {
    const pool = new LiveSessionPool();
    const copy = session(pool, 'a', 'C:\\work\\repo-worktrees\\feature-one');
    const nested = session(pool, 'b', 'C:/work/repo-worktrees/feature-one/src');
    const sibling = session(pool, 'c', 'C:\\work\\repo-worktrees\\feature-one-two');
    const parent = session(pool, 'd', 'C:\\work\\repo');

    const result = pool.closeIdleIn('c:/work/repo-worktrees/feature-one/');
    await result.closed;

    expect(result.busy).toBe(0);
    expect([copy.alive, nested.alive, sibling.alive, parent.alive]).toEqual([
      false,
      false,
      true,
      true,
    ]);
    expect(pool.has('a')).toBe(false);
    expect(pool.has('c')).toBe(true);
    pool.closeAll();
  });

  it('занятый ходом в папке — никто не закрывается, отказ за уборкой', async () => {
    const pool = new LiveSessionPool();
    const idle = session(pool, 'a', '/work/copy');
    const working = session(pool, 'b', '/work/copy');
    void working.turn('ход', undefined, () => undefined);

    const result = pool.closeIdleIn('/work/copy');
    await result.closed;

    expect(result.busy).toBe(1);
    expect(idle.alive).toBe(true);
    expect(working.alive).toBe(true);
    pool.closeAll();
  });

  // Живой прогон 25.09 (F4c, третий): мягкий конец ввода — CLI выходит, а его
  // MCP-серверы с тем же cwd живут ещё секунды, и проба «папку никто не держит»
  // отказывала «держит процесс» на первом нажатии «Убрать копию».
  it('уборка гасит простаивающих деревом, а не концом ввода', async () => {
    const calls: string[] = [];
    const lingering: TransportOpener = (_launch, handlers) => ({
      pid: 1,
      write: () => undefined,
      end: () => void calls.push('end'),
      kill: () => {
        calls.push('kill');
        handlers.close(1);
      },
      detach: () => undefined,
    });
    const pool = new LiveSessionPool();
    const live = new LiveSession(
      { command: 'cli', args: [], cwd: '/work/copy', env: {}, shell: false, signature: 's' },
      Date.now,
      lingering,
    );
    live.sessionId = 'a';
    pool.keep(live);

    const result = pool.closeIdleIn('/work/copy', { tree: true });
    await result.closed;

    expect(calls).toEqual(['kill']);
    expect(live.alive).toBe(false);
    pool.closeAll();
  });
});
