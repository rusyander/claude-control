import type { IntegrationId, TelegramEvent } from '@agentdeck/contracts';
import type { IntegrationDraft } from './draft.types';
import { INTEGRATION_FIELDS } from './draft.constants';

export interface BuildSettingsInput {
  id: IntegrationId;
  draft: IntegrationDraft;
  enabled: boolean;
  /** У Telegram и вебхука: о чём писать. У остальных не читается. */
  events?: TelegramEvent[];
}

/**
 * Тело запроса на сохранение. Значения обрезаются по краям: адрес, скопированный
 * из браузера, почти всегда приезжает с пробелом, а сравнить его с сохранённым
 * потом уже нечем.
 */
export function buildSettings({
  id,
  draft,
  enabled,
  events,
}: BuildSettingsInput): Record<string, unknown> {
  const result: Record<string, unknown> = { enabled };
  for (const field of INTEGRATION_FIELDS[id]) {
    result[field.key] = (draft[field.key] ?? '').trim();
  }
  if (id === 'telegram' || id === 'webhook') result.events = events ?? [];
  return result;
}
