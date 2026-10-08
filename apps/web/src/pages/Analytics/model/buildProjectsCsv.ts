import type { ProjectUsage } from '@agentdeck/contracts';
import { toCsv } from './toCsv';
import { tokenCells } from './tokenCells';

/** Колонки CSV по проектам. */
export const PROJECT_CSV_HEADER = [
  'project',
  'displayName',
  'total',
  'input',
  'output',
  'cacheRead',
  'cacheCreation',
  'requests',
  'estimatedCost',
  'sessions',
  'lastActivity',
] as const;

/** CSV по проектам: расход, стоимость, число сессий и последняя активность. */
export function buildProjectsCsv(byProject: ProjectUsage[]): string {
  return toCsv(
    PROJECT_CSV_HEADER,
    byProject.map((project) => [
      project.project,
      project.displayName,
      ...tokenCells(project.totals),
      project.estimatedCost,
      project.sessions,
      project.lastActivity,
    ]),
  );
}
