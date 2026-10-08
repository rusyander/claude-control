import { saveDraft } from './saveDraft';
import { clearDraft } from './clearDraft';
import { loadDraft } from './draft-storage';

/**
 * Перенести черновик с одного ключа контекста на другой.
 *
 * Нужно, когда новый чат становится настоящим: его ключ меняется с `home`/
 * `project:…` на `chat:<id>`, а всё, что было записано под старым ключом (текст
 * поля, пер-чат оверрайд модели/усилия), иначе потерялось бы. Переносим только
 * непустое значение и стираем старый ключ, чтобы не плодить мусор. Пустой
 * источник или совпадающие ключи — no-op.
 */
export function migrateDraft(fromKey: string, toKey: string): void {
  if (fromKey === toKey) return;
  const value = loadDraft(fromKey);
  if (!value) return;
  saveDraft(toKey, value);
  clearDraft(fromKey);
}
