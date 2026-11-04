import type { GoosePermissionDraft } from '../provider-permissions.ts';
import { GOOSE_MODES, type GooseMode } from '../vocabulary.ts';

/**
 * Разобрать черновик прав Goose: один ключ `mode` из задокументированного набора
 * (`auto`, `approve`, `smart_approve`, `chat`). Списков у Goose нет.
 */
export function parseGooseDraft(rec: Record<string, unknown>): GoosePermissionDraft | undefined {
  const mode = rec.mode;
  if (typeof mode !== 'string' || !(GOOSE_MODES as readonly string[]).includes(mode)) {
    return undefined;
  }
  return { mode: mode as GooseMode };
}
