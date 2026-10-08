import type { ModelSource } from '@agentdeck/contracts';

/** Значение поля выбора источника, приведённое к допустимому. */
export function sourceValue(raw: string): ModelSource {
  return raw === 'platform' ? 'platform' : 'models.dev';
}
