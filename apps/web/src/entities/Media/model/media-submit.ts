import type { MediaDeck, MediaDeckPlan, MediaImagePlan } from '@agentdeck/contracts';
import type { ComposerMode, ComposerModeState } from './composer-mode';
import type { MediaModeView } from './media-mode';

/**
 * Что сделает отправка в неттекстовом режиме.
 *
 * Решение вынесено из хука чистой функцией по той же причине, что и слова
 * доступности (`media-mode.ts`): дорога, вид просьбы и «правка это или новая
 * колода» — правила, а не состояние. Правило, живущее внутри хука, проверяется
 * только глазами: браузерного окружения в прогонах фронта нет намеренно, и
 * появиться оно должно не ради одного хука.
 */
export type MediaAction =
  /** Просьба агенту разговора: текст собирает сервер, отправляет страница. */
  | { road: 'agent'; kind: 'picture' | 'deck' | 'deck-revise'; topic: string; reviseOf?: string }
  /** Панель рисует сама: контур, ручка картинок или свой эндпоинт. */
  | { road: 'image'; prompt: string }
  /** Панель собирает колоду сама; правка несёт прежнюю полем запроса. */
  | { road: 'deck'; prompt: string; reviseOf?: string };

export interface MediaPlans {
  image?: MediaImagePlan;
  deck?: MediaDeckPlan;
}

/**
 * Дорога отправки. Пусто — делать нечего: обычный текст или пустое поле.
 *
 * Доступность здесь НЕ проверяется второй раз: её решил сервер, и запертый пункт
 * до отправки не доходит. Считать её тут заново — та самая болезнь, которую в Т6
 * вылечил один общий `chooseRunModel`.
 */
export function planMediaSubmit(
  mode: ComposerMode,
  text: string,
  plans: MediaPlans,
  revising?: MediaDeck,
): MediaAction | undefined {
  const asked = text.trim();
  if (!asked || mode === 'text') return undefined;

  if (mode === 'image') {
    return plans.image?.source === 'agent'
      ? { road: 'agent', kind: 'picture', topic: asked }
      : { road: 'image', prompt: asked };
  }

  // Правка идёт той же дорогой, что и сборка, и несёт с собой прежнюю колоду: на
  // дороге агента — внутри просьбы (структуру знает только сервер), на своей —
  // полем запроса.
  const reviseOf = revising?.id;
  if (plans.deck?.source === 'agent') {
    return {
      road: 'agent',
      kind: reviseOf ? 'deck-revise' : 'deck',
      topic: asked,
      ...(reviseOf ? { reviseOf } : {}),
    };
  }
  return { road: 'deck', prompt: asked, ...(reviseOf ? { reviseOf } : {}) };
}

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
