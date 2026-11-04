import type { CursorPermissionDraft } from '../provider-permissions.ts';
import { parseToolList } from './normalize.ts';

/**
 * Разобрать черновик прав Cursor: ровно два списка правил. Формы правил
 * (`Shell(...)`, `Read(...)`, …) не проверяются: документация допускает шаблоны и
 * синтаксис `команда:аргументы`, и отсев «непонятного» вырезал бы рабочие правила
 * пользователя. Проверяется ровно то, что можно проверить не гадая, — что это
 * непустые строки (см. `parseToolList`).
 */
export function parseCursorDraft(rec: Record<string, unknown>): CursorPermissionDraft | undefined {
  const allow = parseToolList(rec.allow);
  const deny = parseToolList(rec.deny);
  if (!allow || !deny) return undefined;
  return { allow, deny };
}
