import type { LocalModelsInfo } from '@agentdeck/contracts/local-models';
import { catalogRows } from './catalogRows';

/**
 * Модель для «Claude Code на локальной модели»: уже включённая, иначе та, что
 * отдана агентам, иначе рекомендованная из скачанных, иначе первая скачанная
 * из каталога. Нет ни одной — галочке включать нечего.
 */
export function claudeModelOf(info: LocalModelsInfo): string {
  if (info.claude.model) return info.claude.model;
  if (info.connect.model) return info.connect.model;
  const installed = new Set(info.installed.map((item) => item.tag));
  const rows = catalogRows(info).filter((row) => installed.has(row.model.tag));
  return (rows.find((row) => row.recommended) ?? rows[0])?.model.tag ?? '';
}
