import { csvCell } from './report';
import type { Analytics } from '@agentdeck/contracts';
import { buildDailyCsv } from './buildDailyCsv';
import { buildModelsCsv } from './buildModelsCsv';
import { buildProjectsCsv } from './buildProjectsCsv';
import { buildSessionsCsv } from './buildSessionsCsv';

/** Заголовок секции отдельной строкой-ячейкой над её таблицей. */
export function titledSection(title: string, csv: string): string {
  return `${csvCell(title)}\r\n${csv}`;
}

/**
 * Полный CSV-отчёт: все разрезы в одном файле, секции разделены пустой строкой
 * и подписаны. Одна кнопка — весь расход: по дням, моделям, проектам и сессиям.
 */
export function buildReportCsv(data: Analytics): string {
  return [
    titledSection('По дням', buildDailyCsv(data.byDay)),
    titledSection('По моделям', buildModelsCsv(data.byModel)),
    titledSection('По проектам', buildProjectsCsv(data.byProject)),
    titledSection('Недавние сессии', buildSessionsCsv(data.recentSessions)),
  ].join('\r\n\r\n');
}
