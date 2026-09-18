import type { MediaDeckPlan, MediaImagePlan } from '@agentdeck/contracts';

/**
 * Чистая часть режимов «Картинка» и «Презентация»: что меню обязано показать по
 * плану сервера.
 *
 * Отдельно от хука намеренно. Решение здесь ровно одно — какими словами
 * называется доступность, — и именно оно врёт заметнее всего: пункт, запертый
 * без причины, читается как поломка панели, подпись без оговорки про промпт
 * читается как «моя правка промпта не сработала», а «рисовать некому» там, где
 * рисует агент разговора, — прямая неправда (её и снял владелец 13.09.2026). Хук
 * вокруг этого держит только состояние.
 *
 * Жить это здесь, в сущности, а не на странице: тот же расчёт нужен и чату
 * Claude, и чату чужого CLI, а страница страницу импортировать не вправе.
 */

export interface MediaModeView {
  available: boolean;
  /** Причина словами. Пусто — план ещё не приехал: чужой диагноз не выдумываем. */
  reasonText?: string;
  /** Чем сделает: кто, какой моделью и уедет ли промпт режима. */
  sourceText?: string;
}

/** Перевод ключа словаря — та же подпись, что у `t` из i18next. */
type Translate = (key: string, values?: Record<string, string>) => string;

/**
 * Кто и чем нарисует. `available` берётся у сервера как есть: единственное, что
 * запирает режим, — отсутствие и растровой дороги, и разговора (`no-agent`).
 */
export function imageModeView(plan: MediaImagePlan | undefined, t: Translate): MediaModeView {
  if (!plan) return { available: false };
  if (!plan.available) {
    // Причина приходит кодом, текст живёт в словаре: план без кода оставляет на
    // экране общее «рисовать нечем», а не придуманную причину.
    return plan.reason
      ? { available: false, reasonText: withDetail(t(`chat.mode.blocked.${plan.reason}`), plan) }
      : { available: false };
  }

  const { title, model, promptSent, source } = plan;
  // Дорога агента говорит о себе иначе: ни контура, ни модели панель здесь не
  // знает, зато обязана сказать, ЧТО получится — вектор, нарисованный кодом, а не
  // снимок. Без этой оговорки человек ждёт фотографию и считает ответ поломкой.
  const parts = [source === 'agent' ? t('chat.mode.sourceAgent') : whoAndWhat(title, model, t)];
  // Почему нет РАСТРА — рядом с работающей дорогой, а не вместо неё: чинится
  // именно это, и молчание читалось бы как «панель умеет только так».
  if (plan.rasterReason) {
    parts.push(withDetail(t(`chat.mode.noRaster.${plan.rasterReason}`), plan));
  }
  // Промпт режима уезжает не на всех дорогах, и молчание об этом читалось бы как
  // «правка промпта не сработала».
  if (!promptSent) parts.push(t('chat.mode.promptSkipped'));

  return { available: true, sourceText: parts.join(' · ') };
}

/**
 * Отказ словами от того, кто отказал, — рядом с нашей причиной, а не вместо неё.
 *
 * Появляется у `gateway-failed`: тумблер шлюза включён, панель попробовала
 * поднять слушатель сама и не смогла. Нажимать человеку нечего, и «шлюз не
 * поднялся» без причины отказа оставляет его ровно там же, где он был.
 */
function withDetail(text: string, plan: { reasonDetail?: string }): string {
  return plan.reasonDetail ? `${text} — ${plan.reasonDetail}` : text;
}

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

/** Кто и какой моделью. Модели может не быть — выдумывать её имя нельзя. */
function whoAndWhat(title: string, model: string, t: Translate): string {
  return model ? t('chat.mode.source', { title, model }) : t('chat.mode.sourceNoModel', { title });
}
