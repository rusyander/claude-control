import type { IntegrationDraft } from './draft.types';
import type { IntegrationId } from '@agentdeck/contracts';
import { INTEGRATION_FIELDS } from './draft.constants';

/** Незаполненные обязательные поля. Пусто — коннектор можно включать. */
export function missingFields(id: IntegrationId, draft: IntegrationDraft): string[] {
  return INTEGRATION_FIELDS[id]
    .filter((field) => field.isRequired && !(draft[field.key] ?? '').trim())
    .map((field) => field.key);
}
