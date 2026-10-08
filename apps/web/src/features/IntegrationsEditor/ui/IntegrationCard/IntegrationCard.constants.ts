import type { BadgeTone } from '@shared/ui/badge';

/** Итог проверки цветом: настроено, отвалилось, ещё не спрашивали. */
export const STATE_TONE: Record<string, BadgeTone> = {
  ok: 'success',
  error: 'danger',
  unchecked: 'neutral',
};
