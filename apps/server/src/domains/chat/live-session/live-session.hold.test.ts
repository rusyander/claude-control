import { describe, it, expect, vi, afterEach } from 'vitest';
import type { TransportHandlers } from '../live-transport/live-transport.ts';
import { HOLD_DRAIN_MS, LiveSession, type TurnOutcome } from './live-session.ts';

/**
 * Прогон, держащий ждущую сессию (`awaitTurn`): заводится, когда фоновому
 * субагенту после конца хода нужна карточка прав. Он обязан забрать следующий
 * ход CLI, знать, что идёт в фоне, и не висеть вечно, если фон опустел без хода.
 */

let handlers: TransportHandlers;
const written: string[] = [];

function session(): LiveSession {
  written.length = 0;
  return new LiveSession(
    { command: 'x', args: [], cwd: '.', env: {}, shell: false, signature: 's' },
    Date.now,
    (_launch, h) => {
      handlers = h;
      return {
        pid: 1,
        write: (line) => written.push(line),
        end: () => undefined,
        kill: () => undefined,
        detach: () => undefined,
      };
    },
  );
}

const emit = (event: object): void => handlers.line(JSON.stringify(event));
const agent = { task_id: 'a1', task_type: 'local_agent', description: 'Fetch MR !990' };

afterEach(() => {
  vi.useRealTimers();
});

describe('LiveSession.awaitTurn', () => {
  it('забирает следующий ход CLI целиком и ничего не пишет в stdin', async () => {
    const live = session();
    emit({ type: 'system', subtype: 'background_tasks_changed', tasks: [agent] });
    expect(live.backgroundList).toEqual([
      { id: 'a1', type: 'local_agent', description: 'Fetch MR !990' },
    ]);
    const seen: string[] = [];
    const done = live.awaitTurn('run-1', (raw) => seen.push(String(raw.type)));
    expect(done).toBeDefined();
    expect(live.busy).toBe(true);
    emit({ type: 'system', subtype: 'background_tasks_changed', tasks: [] });
    emit({ type: 'system', subtype: 'init', session_id: 's1' });
    emit({ type: 'result', subtype: 'success', origin: { kind: 'task-notification' } });
    const outcome = (await done) as TurnOutcome;
    expect(outcome.closed).toBe(false);
    expect(seen).toEqual(['system', 'system', 'result']);
    expect(written).toEqual([]);
    expect(live.busy).toBe(false);
  });

  it('фон опустел, а хода нет — через HOLD_DRAIN_MS прогон закрывается пустым', async () => {
    vi.useFakeTimers();
    const live = session();
    emit({ type: 'system', subtype: 'background_tasks_changed', tasks: [agent] });
    const done = live.awaitTurn(undefined, () => undefined);
    vi.advanceTimersByTime(HOLD_DRAIN_MS * 3);
    expect(live.busy).toBe(true);
    emit({ type: 'system', subtype: 'background_tasks_changed', tasks: [] });
    vi.advanceTimersByTime(HOLD_DRAIN_MS - 1);
    expect(live.busy).toBe(true);
    vi.advanceTimersByTime(1);
    await expect(done).resolves.toMatchObject({ closed: false });
    expect(live.busy).toBe(false);
  });

  it('ход начался — срок пустого фона больше не действует', async () => {
    vi.useFakeTimers();
    const live = session();
    const done = live.awaitTurn(undefined, () => undefined);
    emit({ type: 'system', subtype: 'init', session_id: 's1' });
    vi.advanceTimersByTime(HOLD_DRAIN_MS * 2);
    expect(live.busy).toBe(true);
    emit({ type: 'result', subtype: 'success' });
    await expect(done).resolves.toMatchObject({ closed: false });
  });

  it('занятая ходом сессия не отдаётся второму прогону; закрытая — исход закрытия', async () => {
    const live = session();
    void live.turn('hi', undefined, () => undefined);
    expect(live.awaitTurn(undefined, () => undefined)).toBeUndefined();
    handlers.close(1);
    await expect(live.awaitTurn(undefined, () => undefined)).resolves.toMatchObject({
      closed: true,
    });
  });
});
