import type { PlatformActivationNotice, PlatformSmokeResult } from '@agentdeck/contracts';
import type { AppState } from './app-store.types.ts';

/**
 * Следы активации контура: итог последнего пробного запроса и разовый рассказ о
 * переносе старых настроек.
 *
 * Здесь, а не в настройках, по той же причине, что и проба: настройки уезжают
 * экспортом на другую машину, а «модель ответила за 900 мс» — свойство ЭТОГО
 * стенда и этой минуты. Ответ модели в записи есть, и он короткий по замыслу:
 * пробный запрос просит одно слово, и обрезка стоит на записи, а не на экране,
 * — иначе разговорчивая модель клала бы в `state.json` килобайты текста при
 * каждом нажатии.
 */

/** Сколько символов ответа храним. Пробный вопрос просит ОДНО слово. */
const ANSWER_LIMIT = 200;

export function getPlatformSmoke(state: AppState): Record<string, PlatformSmokeResult> {
  return structuredClone(state.platformSmoke ?? {});
}

export function savePlatformSmoke(state: AppState, id: string, result: PlatformSmokeResult): void {
  state.platformSmoke ??= {};
  state.platformSmoke[id] = { ...result, answer: result.answer.slice(0, ANSWER_LIMIT) };
}

/** Контур удалён — след пробного запроса уходит вместе с ним. */
export function forgetPlatformSmoke(state: AppState, id: string): boolean {
  if (!state.platformSmoke || !(id in state.platformSmoke)) return false;
  delete state.platformSmoke[id];
  return true;
}

export function getPlatformActivationNotice(state: AppState): PlatformActivationNotice | undefined {
  return state.platformActivationNotice
    ? structuredClone(state.platformActivationNotice)
    : undefined;
}

export function setPlatformActivationNotice(
  state: AppState,
  notice: PlatformActivationNotice,
): void {
  state.platformActivationNotice = notice;
}

/**
 * Человек прочитал — сообщение уходит навсегда.
 *
 * Именно навсегда, а не «до следующего чтения настроек»: перенос случился один
 * раз, и повторно показанный рассказ о нём читается как новое событие.
 */
export function clearPlatformActivationNotice(state: AppState): boolean {
  if (!state.platformActivationNotice) return false;
  delete state.platformActivationNotice;
  return true;
}
