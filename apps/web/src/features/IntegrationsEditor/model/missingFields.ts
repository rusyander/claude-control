import type { IntegrationField, IntegrationDraft } from './draft.types';
import type { IntegrationId } from '@agentdeck/contracts';
import { INTEGRATION_FIELDS } from './draft.constants';

/** Обязательно ли поле при том, что сейчас в форме. */
export function isRequiredNow(field: IntegrationField, draft: IntegrationDraft): boolean {
  if (field.isRequired) return true;
  const rule = field.requiredWhen;
  return rule ? rule.equals.includes((draft[rule.key] ?? '').trim()) : false;
}

/** Незаполненные обязательные поля. Пусто — коннектор можно включать. */
export function missingFields(id: IntegrationId, draft: IntegrationDraft): string[] {
  return INTEGRATION_FIELDS[id]
    .filter((field) => isRequiredNow(field, draft) && !(draft[field.key] ?? '').trim())
    .map((field) => field.key);
}
