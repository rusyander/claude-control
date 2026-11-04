import type { ContinuePermissionDraft } from '../provider-permissions.ts';
import { parseToolList } from './normalize.ts';

/**
 * Разобрать черновик прав Continue: три списка правил и никакого режима. Правила —
 * непрозрачные строки (синтаксис не толкуется, только хранится), поэтому
 * проверяется ровно форма: массив непустых строк без повторов (`parseToolList`).
 */
export function parseContinueDraft(
  rec: Record<string, unknown>,
): ContinuePermissionDraft | undefined {
  // У Continue нет режима, по которому тело опознаётся как черновик прав, поэтому
  // хотя бы один из трёх списков обязан присутствовать: иначе любое постороннее
  // тело (`{}`, чужой черновик) читалось бы как «всё пусто» и стирало файл.
  if (!('allow' in rec) && !('ask' in rec) && !('exclude' in rec)) return undefined;
  const allow = parseToolList(rec.allow);
  const ask = parseToolList(rec.ask);
  const exclude = parseToolList(rec.exclude);
  if (!allow || !ask || !exclude) return undefined;
  return { allow, ask, exclude };
}
