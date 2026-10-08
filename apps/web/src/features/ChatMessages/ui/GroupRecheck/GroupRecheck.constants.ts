import type { RecheckView } from './GroupRecheck.types';

/** Подпись и подсказка кнопки по состоянию перепроверки. */
export const TEXTS: Record<RecheckView, { label: string; hint: string }> = {
  open: { label: 'chat.cascade.hub.recheck.action', hint: 'chat.cascade.hub.recheck.hint' },
  pending: {
    label: 'chat.cascade.hub.recheck.pending',
    hint: 'chat.cascade.hub.recheck.pendingHint',
  },
  checked: {
    label: 'chat.cascade.hub.recheck.checked',
    hint: 'chat.cascade.hub.recheck.checkedHint',
  },
};
