import type { MediaImagePlan } from '@agentdeck/contracts';
import type { Translate, MediaModeView } from './media-mode.types';
import { whoAndWhat } from './whoAndWhat';

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
