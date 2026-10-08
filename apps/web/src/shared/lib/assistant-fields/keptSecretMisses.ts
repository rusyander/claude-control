import type { AssistantMiss } from './assistant-fields.types';

/**
 * Поля, где модель переписала маску секрета так, что сервер не смог вернуть
 * секрет на место: форма их не трогает, лента называет.
 */
export function keptSecretMisses(kept: readonly string[] | undefined): AssistantMiss[] {
  return (kept ?? []).map((field) => ({ field, reason: 'secret' }));
}
