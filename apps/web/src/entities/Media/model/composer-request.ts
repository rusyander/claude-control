import type { ComposerMode } from './composer-mode';
import { listeners } from './composer-request.constants';

/**
 * Режим, который композер чата должен принять при следующем показе.
 *
 * Просит его тот, кто открывает чат не руками человека: агент панели начал
 * разговор-презентацию, и страница обязана открыться с пунктом «Презентация», а
 * не «Сообщение» — иначе правка колоды следующим сообщением ушла бы простым
 * текстом. Страницы чата в момент просьбы может ещё не быть (переход идёт следом),
 * поэтому просьба ЗАЩЁЛКИВАЕТСЯ и забирается один раз: первым смонтированным
 * композером или уже живым — по сигналу.
 *
 * Защёлка живёт, пока идёт переход, а не до следующего чата: при активном
 * чужом CLI агентский чат открывается его страницей, просьбу никто не забирает,
 * и без срока чат Claude, открытый человеком много позже, начался бы с
 * «Презентации» (ревью 28.09, F-192).
 */
export const COMPOSER_REQUEST_TTL_MS = 10_000;

let requested: { mode: ComposerMode; at: number } | undefined;

export function requestComposerMode(mode: ComposerMode, now = Date.now()): void {
  requested = { mode, at: now };
  for (const listener of listeners) listener();
}

/** Чей композер спрашивает: чат Claude или чат чужого CLI. */
export type ComposerHost = 'chat' | 'provider-chat';

/**
 * Забрать просьбу: второй вызов вернёт пусто, режим не навязывается дважды.
 * Агент открывает только чат Claude, и живой композер чужого CLI просьбу не
 * трогает: забери он её, чат, открытый следом, начался бы с «Сообщения».
 */
export function takeComposerMode(host: ComposerHost, now = Date.now()): ComposerMode | undefined {
  if (host !== 'chat') return undefined;
  const taken = requested;
  requested = undefined;
  if (!taken || now - taken.at > COMPOSER_REQUEST_TTL_MS) return undefined;
  return taken.mode;
}
