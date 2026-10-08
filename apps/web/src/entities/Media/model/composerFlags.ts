import type { MediaModeView } from './media-mode.types';
import type { MediaPlans } from './media-submit.types';
import type { MediaDeck } from '@agentdeck/contracts';
import type { ComposerModeState } from './composer-mode';

/**
 * Поля состояния композера, которые считаются, а не хранятся: доступность обоих
 * режимов их словами, признак «рисует агент», занятость и заголовок правки.
 */
export function composerFlags(input: {
  image: MediaModeView;
  deck: MediaModeView;
  plans: MediaPlans;
  isBusy: boolean;
  revising?: MediaDeck;
}): Omit<ComposerModeState, 'mode' | 'onModeChange' | 'onReviseCancel'> {
  const { image, deck, plans, isBusy, revising } = input;
  return {
    imageAvailable: image.available,
    ...(image.reasonText ? { imageReason: image.reasonText } : {}),
    ...(image.sourceText ? { imageSource: image.sourceText } : {}),
    // Признак нужен подсказке в пустом поле: «панель нарисует сама» на дороге
    // агента — прямая неправда, а человек читает именно её.
    ...(plans.image?.source === 'agent' ? { imageByAgent: true } : {}),
    deckAvailable: deck.available,
    ...(deck.reasonText ? { deckReason: deck.reasonText } : {}),
    ...(deck.sourceText ? { deckSource: deck.sourceText } : {}),
    isDrawing: isBusy,
    ...(revising ? { reviseTitle: revising.title } : {}),
  };
}
