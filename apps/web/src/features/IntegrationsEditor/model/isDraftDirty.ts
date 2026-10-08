import type { IntegrationId, IntegrationsSettings } from '@agentdeck/contracts';
import type { IntegrationDraft } from './draft.types';
import { INTEGRATION_FIELDS } from './draft.constants';
import { draftFrom } from './draft';

/** Отличается ли форма от сохранённого — по нему гаснет кнопка «Сохранить». */
export function isDraftDirty(
  id: IntegrationId,
  draft: IntegrationDraft,
  settings: IntegrationsSettings[IntegrationId],
): boolean {
  const saved = draftFrom(id, settings as never);
  return INTEGRATION_FIELDS[id].some(
    (field) => (draft[field.key] ?? '').trim() !== (saved[field.key] ?? '').trim(),
  );
}
