import type { LiveTask } from '../journal/resume.ts';

/**
 * Сессии при загрузке (01 §Sessions at core death, P12): хост каждой незаконченной сессии
 * проверяется по pid + старту. Мёртв → `session.transition host-dead → lost` (дальше — правило
 * продолжения, фаза 4). Жив → переподключение хоста (агент C, `session-host`). `unknown` — ничего
 * не объявляется: живую сессию нельзя объявить потерянной по догадке (F25).
 */

export type HostLiveness = 'alive' | 'dead' | 'unknown';

export interface SessionVerdict {
  sessionId: string;
  liveness: HostLiveness;
  action: 'lost' | 'reattach' | 'wait';
}

const OPEN = new Set(['starting', 'live', 'quiet']);

export async function reconcileSessions(
  task: LiveTask,
  isAlive: (id: { pid: number; start: string }) => Promise<HostLiveness>,
  /** Только эти сессии (повторная проверка по таймеру загрузки); нет — все открытые. */
  only?: ReadonlySet<string>,
): Promise<SessionVerdict[]> {
  const verdicts: SessionVerdict[] = [];
  for (const [sessionId, session] of Object.entries(task.state.sessions)) {
    if (!OPEN.has(session.state)) continue;
    if (only && !only.has(sessionId)) continue;
    const liveness = await isAlive({ pid: session.hostPid, start: session.hostStart });
    if (liveness === 'dead') {
      task.append({
        kind: 'session.transition',
        actor: 'core',
        sessionId,
        data: { sessionId, event: 'host-dead', from: session.state, to: 'lost' },
      });
      verdicts.push({ sessionId, liveness, action: 'lost' });
    } else {
      verdicts.push({ sessionId, liveness, action: liveness === 'alive' ? 'reattach' : 'wait' });
    }
  }
  return verdicts;
}
