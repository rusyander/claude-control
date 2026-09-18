import type { MediaImage, MediaImagePlan } from '@agentdeck/contracts';
import type { Dictionary } from '../../shared/config/i18n/ru';

/**
 * Режим «Картинка» на телефоне (Т9) — чистая часть: какими словами назвать
 * доступность и какой дорогой отправить. Повторяет `media-mode.ts` и
 * `media-submit.ts` панели по смыслу, а не по коду: словари разные, а ввезти
 * тот модуль Metro не может.
 *
 * ДОСТУПНОСТЬ ЗДЕСЬ НЕ СЧИТАЕТСЯ. Её решает сервер (`GET /media/images/plan`):
 * ответ собирается из драйвера контура, каталога пробы и профилей эндпоинтов, и
 * догадка на телефоне разошлась бы с настоящим маршрутом — та же болезнь, что
 * вылечил `chooseRunModel` в Т6. Пока план не приехал, пункт заперт без причины:
 * чужой диагноз не выдумываем.
 */

type Words = Dictionary['composer']['mode'];

export interface ImageModeView {
  available: boolean;
  /** Почему заперт, словами. Пусто — план ещё не приехал или причины нет. */
  reasonText?: string;
  /** Кто и чем нарисует, с оговорками про растр и промпт режима. */
  sourceText?: string;
  /** Рисует агент разговора, а не панель: подсказка в поле обязана это сказать. */
  byAgent: boolean;
}

/**
 * Отказ словами от того, кто отказал, — рядом с нашей причиной, а не вместо неё.
 *
 * Та же дописка, что в панели (`withDetail` в `entities/Media/model/media-mode.ts`):
 * появляется у `gateway-failed`, и без неё человек читает «шлюз панели не
 * поднялся» без единого слова о том, чем именно. Нажимать ему нечего, а телефон
 * до ревью Т13 эту половину просто терял.
 */
function withDetail(text: string, plan: { reasonDetail?: string }): string {
  return plan.reasonDetail ? `${text} — ${plan.reasonDetail}` : text;
}

export function imageModeView(plan: MediaImagePlan | undefined, words: Words): ImageModeView {
  if (!plan) return { available: false, byAgent: false };
  if (!plan.available) {
    return plan.reason
      ? {
          available: false,
          reasonText: withDetail(words.blocked[plan.reason], plan),
          byAgent: false,
        }
      : { available: false, reasonText: words.imageBlocked, byAgent: false };
  }

  const byAgent = plan.source === 'agent';
  const parts = [byAgent ? words.sourceAgent : words.source(plan.title, plan.model)];
  if (plan.rasterReason) parts.push(withDetail(words.noRaster[plan.rasterReason], plan));
  if (!plan.promptSent) parts.push(words.promptSkipped);
  return { available: true, sourceText: parts.join(' · '), byAgent };
}

/** Что сделает отправка в режиме картинки. */
export type ImageAction =
  /** Просьбу агенту собирает сервер (`/media/prompt`), уходит обычным сообщением. */
  | { road: 'agent'; topic: string }
  /** Панель рисует сама: результат — файл и карточка, не реплика в переписке. */
  | { road: 'image'; prompt: string };

/**
 * Дорога отправки. Пусто — нечего делать (пустое поле или план не приехал):
 * доступность второй раз не проверяется, запертый пункт до отправки не доходит.
 */
export function planImageSubmit(
  plan: MediaImagePlan | undefined,
  text: string,
): ImageAction | undefined {
  const asked = text.trim();
  if (!asked || !plan?.available) return undefined;
  return plan.source === 'agent'
    ? { road: 'agent', topic: asked }
    : { road: 'image', prompt: asked };
}

/** Разговор, к которому привязать картинку: у черновика `new-*` его ещё нет. */
export function mediaChatId(chatId: string): string {
  return chatId.startsWith('new-') ? '' : chatId;
}

/** Адрес байтов картинки — тот же, что у панели, для показа и скачивания. */
export function mediaImagePath(id: string): string {
  return `/media/images/${encodeURIComponent(id)}`;
}

/** Подпись карточки: кто нарисовал и какой размер. */
export function imageCardLines(image: MediaImage, words: Words): string[] {
  const source = words.card.source[image.source];
  const lines = [image.model ? words.card.by(image.model, source) : words.card.byNoModel(source)];
  const size = formatBytes(image.sizeBytes);
  lines.push(image.width && image.height ? words.card.size(image.width, image.height, size) : size);
  return lines;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
