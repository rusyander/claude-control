import type { AssistantMiss } from './assistant-fields.types';

/** Непринятое по причинам — для строк под ответом помощника. */
export function groupMisses(missed: readonly AssistantMiss[]): {
  values: string[];
  types: string[];
  fields: string[];
  secrets: string[];
} {
  return {
    values: missed
      .filter((miss) => miss.reason === 'unknown-value')
      .map((miss) => `${miss.field}: ${(miss.values ?? []).join(', ')}`),
    types: missed.filter((miss) => miss.reason === 'wrong-type').map((miss) => miss.field),
    fields: missed
      .filter((miss) => miss.reason === 'unknown-field' || miss.reason === 'locked')
      .map((miss) => miss.field),
    secrets: missed.filter((miss) => miss.reason === 'secret').map((miss) => miss.field),
  };
}
