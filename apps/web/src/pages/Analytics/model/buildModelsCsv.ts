import type { ModelUsage } from '@agentdeck/contracts';
import { toCsv } from './toCsv';
import { tokenCells } from './tokenCells';

/** Колонки CSV по моделям. */
export const MODEL_CSV_HEADER = [
  'model',
  'total',
  'input',
  'output',
  'cacheRead',
  'cacheCreation',
  'requests',
  'estimatedCost',
] as const;

/** CSV по моделям: разрез, который для отчёта нужен чаще дневного. */
export function buildModelsCsv(byModel: ModelUsage[]): string {
  return toCsv(
    MODEL_CSV_HEADER,
    byModel.map((model) => [model.model, ...tokenCells(model.totals), model.estimatedCost]),
  );
}
