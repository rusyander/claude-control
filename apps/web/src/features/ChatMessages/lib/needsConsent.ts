import axios from 'axios';

/** Отказы, которые снимает согласие человека: потолок групп и лимит подписки. */
export const CONSENT_CODES = new Set([
  'split-group-no-slot',
  'split-group-no-slot-paused',
  'split-limit-active',
]);

export function needsConsent(error: unknown): boolean {
  if (!axios.isAxiosError(error) || error.response?.status !== 409) return false;
  const code = (error.response.data as { messageCode?: unknown } | undefined)?.messageCode;
  return typeof code === 'string' && CONSENT_CODES.has(code);
}
