import type { MediaDeckPlan } from '@agentdeck/contracts';
import type { Translate, MediaModeView } from './media-mode.types';
import { whoAndWhat } from './whoAndWhat';

/**
 * Кто соберёт презентацию. Вторая строка — про PDF: он получается не на всякой
 * машине (нужен системный браузер), и сказать об этом надо ДО нажатия, а не
 * отказом на кнопке «PDF».
 */
export function deckModeView(plan: MediaDeckPlan | undefined, t: Translate): MediaModeView {
  if (!plan) return { available: false };
  if (!plan.available) {
    // Ключ причины отдельным словарём (`noDeck`), а не веткой внутри
    // `deckBlocked`: `deckBlocked` — это общее «собирать нечем» для случая, когда
    // код причины не приехал, и строка с вложенными ключами под одним именем в
    // i18next не живёт.
    return plan.reason
      ? { available: false, reasonText: t(`chat.mode.noDeck.${plan.reason}`) }
      : { available: false };
  }

  const { title, model, source } = plan;
  const parts = [source === 'agent' ? t('chat.mode.deckSourceAgent') : whoAndWhat(title, model, t)];
  if (!plan.pdf.available) parts.push(t(`chat.mode.noPdf.${plan.pdf.reason ?? 'no-browser'}`));

  return { available: true, sourceText: parts.join(' · ') };
}
