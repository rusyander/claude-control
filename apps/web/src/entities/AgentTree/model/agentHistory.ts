import type { AgentHistory, AgentHistorySession } from '@agentdeck/contracts/agent-history';
import type { AgentAnomalies, ProgressAgent } from '@agentdeck/contracts';
import type { TFunction } from 'i18next';
import { formatDuration } from '@shared/lib/format-duration';
import { agentState } from './agentTree';
import type { AgentState } from './agentTree.types';
import type { IndexedSession, LiveCountParts, LiveNow } from './agentHistory.types';

/**
 * Состояние субагента в истории. Текущая сессия — как в дереве «Плана
 * агента»; прошлая кончилась вместе со своим процессом, и «идёт» там — оборван,
 * а не работает (иначе окно звало бы вчерашнего агента живым).
 */
export function historyAgentState(
  agent: ProgressAgent,
  session: Pick<AgentHistorySession, 'current' | 'liveAgents'>,
  isRunning: boolean,
): AgentState {
  const state = session.current ? agentState(agent, isRunning) : agentState(agent, false, false);
  // «Идёт» — только у того, кого сервер числит работающим сейчас (`liveAgents`):
  // молчащий дольше порога в окне и в «сейчас: …» один и тот же — оборван.
  // Нет отметок — ответ старого сервера, как было.
  if (state === 'running' && session.liveAgents && !session.liveAgents.includes(agent.id)) {
    return 'lost';
  }
  return state;
}

/** Ответ сервера несёт отметки «работает сейчас» — без них окно «Сейчас» не рисуется. */
export function hasLiveMarks(history: Pick<AgentHistory, 'sessions'>): boolean {
  return history.sessions.some(
    (session) => session.liveMain !== undefined || session.liveAgents !== undefined,
  );
}

/** Работает ли в сессии кто-нибудь прямо сейчас — по отметкам сервера. */
export function sessionLive(
  session: Pick<AgentHistorySession, 'liveMain' | 'liveAgents'>,
): boolean {
  return Boolean(session.liveMain) || (session.liveAgents?.length ?? 0) > 0;
}

/** Длительность сессии по первой и последней записи; нет одной из них — нет и длительности. */
export function sessionSpanMs(
  session: Pick<AgentHistorySession, 'startedAt' | 'endedAt'>,
): number | undefined {
  const start = session.startedAt ? Date.parse(session.startedAt) : NaN;
  const end = session.endedAt ? Date.parse(session.endedAt) : NaN;
  return Number.isFinite(start) && Number.isFinite(end) && end >= start ? end - start : undefined;
}

/** Расход главного агента одним числом: вход, кэш и ответ. */
export function mainTokenTotal(session: Pick<AgentHistorySession, 'main'>): number {
  const tokens = session.main.tokens;
  if (!tokens) return 0;
  return tokens.input + tokens.output + tokens.cacheRead + tokens.cacheCreation;
}

/**
 * Номер сессии по порядку запуска: список идёт новыми первыми, а человек
 * считает от первой — «Сессия 1» должна быть самой ранней.
 */
export function sessionNumber(history: Pick<AgentHistory, 'sessions'>, index: number): number {
  return history.sessions.length - index;
}

/** Странности хода строками — только ненулевые, по порядку важности. */
export function anomalyParts(anomalies: AgentAnomalies | undefined, t: TFunction): string[] {
  if (!anomalies) return [];
  const parts: string[] = [];
  if (anomalies.denials > 0)
    parts.push(t('agentTree.anomalies.denials', { count: anomalies.denials }));
  if (anomalies.errors > 0)
    parts.push(t('agentTree.anomalies.errors', { count: anomalies.errors }));
  if (anomalies.repeatedReads.length > 0) {
    parts.push(t('agentTree.anomalies.repeated', { count: anomalies.repeatedReads.length }));
  }
  if (anomalies.largeResults > 0) {
    parts.push(t('agentTree.anomalies.large', { count: anomalies.largeResults }));
  }
  return parts;
}

/** Подсказка к повторным чтениям: какие файлы и сколько раз. */
export function repeatedReadsHint(anomalies: AgentAnomalies | undefined, t: TFunction): string {
  if (!anomalies || anomalies.repeatedReads.length === 0) return '';
  const list = anomalies.repeatedReads.map((read) => `${read.path} ×${read.count}`).join(', ');
  return t('agentTree.anomalies.repeatedHint', { list });
}

/** Обрывы паузой строкой — своим цветом, не среди ошибок; нет — `undefined`. */
export function interruptedPart(
  anomalies: AgentAnomalies | undefined,
  t: TFunction,
): string | undefined {
  const count = anomalies?.interrupted ?? 0;
  return count > 0 ? t('agentTree.anomalies.interrupted', { count }) : undefined;
}

/**
 * «Сейчас работают» рядом с кнопкой: оба числа и слова к ним, пока хоть одно
 * не ноль; никого — `undefined`, и строка говорит «никто не работает». Числа
 * отдельно от слов — их рисуют своим цветом и жирным.
 */
export function liveCountParts(
  history: Pick<AgentHistory, 'live'>,
  t: TFunction,
): LiveCountParts | undefined {
  const { agents, subagents } = history.live;
  if (agents + subagents === 0) return undefined;
  return {
    agents,
    agentsWord: t('agentTree.history.liveAgentsWord', { count: agents }),
    subagents,
    subagentsWord: t('agentTree.history.liveSubagentsWord', { count: subagents }),
  };
}

/**
 * «Сейчас» вверху окна — только по отметкам сервера (`liveMain`, `liveAgents`):
 * те же, из которых сложены числа у кнопки, второго правила «живой» нет.
 * `idle` — сессия для строки «главный агент не работает»: текущая, иначе новейшая.
 */
export function liveNow(history: Pick<AgentHistory, 'sessions'>): LiveNow {
  const mains: IndexedSession[] = [];
  const agents: LiveNow['agents'] = [];
  history.sessions.forEach((session, index) => {
    if (session.liveMain) mains.push({ session, index });
    const ids = new Set(session.liveAgents ?? []);
    for (const agent of session.agents) {
      if (ids.has(agent.id)) agents.push({ session, index, agent });
    }
  });
  const currentIndex = history.sessions.findIndex((session) => session.current);
  const idleIndex = currentIndex >= 0 ? currentIndex : 0;
  const idleSession = history.sessions[idleIndex];
  return {
    mains,
    agents,
    idle:
      mains.length === 0 && idleSession ? { session: idleSession, index: idleIndex } : undefined,
  };
}

/** Сколько прошло с ISO-времени до `now`; битое время — `undefined`, «из будущего» — ноль. */
export function elapsedSince(at: string | undefined, now: number): number | undefined {
  const start = at ? Date.parse(at) : Number.NaN;
  if (!Number.isFinite(start)) return undefined;
  return Math.max(0, now - start);
}

/** Длительность вызова: меньше секунды — в мс, дальше — `4с`, `1м 12с`. */
export function callDuration(ms: number, t: TFunction): string {
  return ms < 1000 ? t('agentTree.extensions.ms', { value: ms }) : formatDuration(ms, t);
}

/** Кнопка видна, когда у разговора есть хоть одна сессия, — с субагентами или без. */
export function hasHistory(history: AgentHistory | undefined): history is AgentHistory {
  return Boolean(history && history.sessions.length > 0);
}
