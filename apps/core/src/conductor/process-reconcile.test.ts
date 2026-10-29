import { describe, expect, it } from 'vitest';
import { openFresh } from '../journal/__fixtures__/journal-harness.ts';
import type { LiveTask } from '../journal/resume.ts';
import { newId } from '../lib/ids/uuidv7.ts';
import { reconcileSessions, type HostLiveness } from './process-reconcile.ts';

function session(task: LiveTask, hostPid: number, live = true): string {
  const sessionId = newId();
  task.append({
    kind: 'session.started',
    actor: 'core',
    sessionId,
    data: {
      sessionId,
      stepId: newId(),
      adapter: 'adapter-a',
      cliVersion: '1',
      route: { kind: 'stub', id: 'stub-1' },
      hops: [],
      credentialKind: 'none',
      modelAsked: 'model-a',
      modelServed: null,
      effort: null,
      hostPid,
      hostStart: `start-${hostPid}`,
      cliPid: null,
      cliStart: null,
      cwd: '/w',
      argv: [],
      resumeOf: null,
      cacheAgeMs: null,
    },
  });
  if (live) {
    task.append({
      kind: 'session.transition',
      actor: 'core',
      sessionId,
      data: { sessionId, event: 'spawned', from: 'starting', to: 'live' },
    });
  }
  return sessionId;
}

describe('process reconcile at boot', () => {
  it('P12 hosts checked by pid + start: dead → lost, alive → reattach, unknown → wait (never declared lost)', async () => {
    const { task } = await openFresh();
    const dead = session(task, 101);
    const alive = session(task, 102);
    const unknown = session(task, 103, false);
    // Процесс с тем же pid, но другим стартом — это другой процесс: хост мёртв.
    const reused = session(task, 104);
    const table: Record<number, string> = { 102: 'start-102', 104: 'start-other' };
    const asked: { pid: number; start: string }[] = [];
    const isAlive = async (id: { pid: number; start: string }): Promise<HostLiveness> => {
      asked.push(id);
      if (id.pid === 103) return 'unknown';
      return table[id.pid] === id.start ? 'alive' : 'dead';
    };
    const verdicts = await reconcileSessions(task, isAlive);
    const by = Object.fromEntries(verdicts.map((v) => [v.sessionId, v.action]));
    expect(by).toEqual({
      [dead]: 'lost',
      [alive]: 'reattach',
      [unknown]: 'wait',
      [reused]: 'lost',
    });
    expect(asked.map((a) => a.start)).toEqual(['start-101', 'start-102', 'start-103', 'start-104']);
    expect(task.state.sessions[dead]?.state).toBe('lost');
    expect(task.state.sessions[reused]?.state).toBe('lost');
    expect(task.state.sessions[alive]?.state).toBe('live');
    expect(task.state.sessions[unknown]?.state).toBe('starting');
    expect(task.state.anomalies).toEqual([]);
    // Закрытые сессии на следующей загрузке не трогаются.
    const again = await reconcileSessions(task, isAlive);
    expect(again.map((v) => v.sessionId).sort()).toEqual([alive, unknown].sort());
    task.close();
  });
});
