import type { IntegrationId, IntegrationsSettings } from '@agentdeck/contracts';
import type { IntegrationDraft } from './draft.types';
import { INTEGRATION_FIELDS } from './draft.constants';

/** Форма из сохранённых настроек: все поля коннектора строками. */
export function draftFrom<T extends IntegrationId>(
  id: T,
  settings: IntegrationsSettings[T],
): IntegrationDraft {
  const source = settings as unknown as Record<string, unknown>;
  const draft: IntegrationDraft = {};
  for (const field of INTEGRATION_FIELDS[id]) {
    const value = source[field.key];
    draft[field.key] = typeof value === 'string' ? value : '';
  }
  return draft;
}
