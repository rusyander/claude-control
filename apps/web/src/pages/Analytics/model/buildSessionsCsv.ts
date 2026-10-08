import type { SessionUsage } from '@agentdeck/contracts';
import { toCsv } from './toCsv';
import { tokenCells } from './tokenCells';

/** Колонки CSV по недавним сессиям. */
export const SESSION_CSV_HEADER = [
  'sessionId',
  'project',
  'displayName',
  'startedAt',
  'lastActivity',
  'total',
  'input',
  'output',
  'cacheRead',
  'cacheCreation',
  'requests',
  'estimatedCost',
  'models',
  'isActive',
  'title',
  'toolCalls',
  'topTools',
] as const;

/**
 * CSV по недавним сессиям. Модели и инструменты склеиваются через `; ` в одну
 * ячейку; длительность в файл не пишется — её даёт разность startedAt и lastActivity.
 */
export function buildSessionsCsv(recentSessions: SessionUsage[]): string {
  return toCsv(
    SESSION_CSV_HEADER,
    recentSessions.map((session) => [
      session.sessionId,
      session.project,
      session.displayName,
      session.startedAt,
      session.lastActivity,
      ...tokenCells(session.totals),
      session.estimatedCost,
      session.models.join('; '),
      session.isActive,
      session.title ?? '',
      session.toolCalls ?? '',
      (session.topTools ?? []).map((tool) => `${tool.name}:${tool.count}`).join('; '),
    ]),
  );
}
