import type { IntegrationDraft } from './draft.types';
import type { IntegrationId } from '@agentdeck/contracts';
import { TELEGRAM_DONE_MAX_MINUTES as MAX_MINUTES } from '@agentdeck/contracts';
import { INTEGRATION_FIELDS } from './draft.constants';

/** Незаполненные обязательные поля. Пусто — коннектор можно включать. */
export function missingFields(id: IntegrationId, draft: IntegrationDraft): string[] {
  return INTEGRATION_FIELDS[id]
    .filter((field) => {
      const value = (draft[field.key] ?? '').trim();
      // Минуты — целое от 0 до суток; иное сохранять нечего.
      if (field.kind === 'minutes') return !isMinutes(value);
      return field.isRequired && !value;
    })
    .map((field) => field.key);
}

function isMinutes(value: string): boolean {
  return /^\d{1,4}$/.test(value) && Number(value) <= MAX_MINUTES;
}
