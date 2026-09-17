import { object, string, type infer as Infer } from 'zod';
import { DECK_PROMPT_MAX } from './media-deck-model.ts';

// Всё без zod — в `media-deck-model.ts` (его грузит и телефон); здесь только
// схемы запросов, и прежние ввозы `@agentdeck/contracts/media-deck` целы.
export * from './media-deck-model.ts';

export const mediaDeckRequestSchema = object({
  /** Разговор, к которому привязать колоду. Пусто — черновик без разговора. */
  chatId: string().default(''),
  /**
   * Тема. Обрезка ДО проверки длины — та же ловушка, что оплачена в Т9: строка
   * из пробелов проходила `min(1)` и уезжала в сеть.
   */
  prompt: string()
    .trim()
    .min(1, 'назовите тему презентации')
    .max(DECK_PROMPT_MAX, 'тема длиннее 4000 знаков'),
  /**
   * Правка готовой колоды: её структура уезжает модели вместе с просьбой, и
   * менять она будет ИМЕННО ЕЁ, а не собирать заново по теме. Без этого поля
   * «поправь третий слайд» означало бы новую колоду с новым текстом везде.
   */
  reviseOf: string().trim().max(64).default(''),
});

export type MediaDeckRequest = Infer<typeof mediaDeckRequestSchema>;

/**
 * Колода, которую панель приняла из блока в ответе агента (дорога `agent`).
 *
 * Отдельный запрос, а не поле в общем: там панель САМА ходит к модели, здесь она
 * принимает то, что агент уже сказал в разговоре. Тема нужна и тут — она станет
 * подписью карточки, и без неё через день по колоде не понять, о чём просили.
 */
export const mediaDeckBlockRequestSchema = object({
  chatId: string().default(''),
  prompt: string().trim().max(DECK_PROMPT_MAX, 'тема длиннее 4000 знаков').default(''),
  /** Тело блока как есть — разбирает и проверяет сервер. */
  block: string().min(1, 'блок пустой'),
  /** Модель разговора, чтобы карточка назвала, кто диктовал. */
  model: string().trim().max(120).default(''),
  /** Колода, которую этот блок заменяет (правка по просьбе человека). */
  reviseOf: string().trim().max(64).default(''),
});

export type MediaDeckBlockRequest = Infer<typeof mediaDeckBlockRequestSchema>;
