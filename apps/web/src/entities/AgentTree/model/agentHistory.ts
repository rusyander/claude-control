import type { AgentHistory, AgentHistorySession } from '@agentdeck/contracts/agent-history';
import type { AgentAnomalies, ProgressAgent } from '@agentdeck/contracts';
import type { TFunction } from 'i18next';
import { formatDuration } from '@shared/lib/format-duration';
import { agentState } from './agentTree';
import type { AgentState } from './agentTree.types';

/**
 * Состояние субагента в истории. Текущая сессия — как в дереве «Плана
 * агента»; прошлая кончилась вместе со своим процессом, и «идёт» там — оборван,
 * а не работает (иначе окно звало бы вчерашнего агента живым).
 */
export function historyAgentState(
  agent: ProgressAgent,
  session: Pick<AgentHistorySession, 'current'>,
  isRunning: boolean,
): AgentState {
  return session.current ? agentState(agent, isRunning) : agentState(agent, false, false);
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

/**
 * «Сейчас работают» рядом с кнопкой: оба числа, пока хоть одно не ноль;
 * никого — `undefined`, и строка говорит «никто не работает».
 */
export function liveLabel(history: Pick<AgentHistory, 'live'>, t: TFunction): string | undefined {
  const { agents, subagents } = history.live;
  if (agents + subagents === 0) return undefined;
  return t('agentTree.history.live', {
    agents: t('agentTree.history.liveAgents', { count: agents }),
    subagents: t('agentTree.history.liveSubagents', { count: subagents }),
  });
}

/** Длительность вызова: меньше секунды — в мс, дальше — `4с`, `1м 12с`. */
export function callDuration(ms: number, t: TFunction): string {
  return ms < 1000 ? t('agentTree.extensions.ms', { value: ms }) : formatDuration(ms, t);
}

/** Кнопка видна, когда у разговора есть хоть одна сессия, — с субагентами или без. */
export function hasHistory(history: AgentHistory | undefined): history is AgentHistory {
  return Boolean(history && history.sessions.length > 0);
}
