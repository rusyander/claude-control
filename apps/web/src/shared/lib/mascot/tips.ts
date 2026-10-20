import type { TipScope } from './tips.types';

/**
 * Советы Деки по месту, где стоит человек. Только факты, которые панель
 * действительно умеет: каждый ключ — текст `mascot.tips.<key>`, и совет о
 * несуществующей клавише хуже, чем никакого.
 */
export const TIP_KEYS: Record<TipScope, readonly string[]> = {
  chat: ['steer', 'enter', 'drop', 'draft', 'tabs', 'notify'],
  settings: ['accent', 'reduceMotion', 'quiet'],
  any: ['palette', 'jump', 'help', 'notify', 'bell', 'limits', 'panelAgent', 'accent', 'me'],
};

/** Какой набор советов уместен на этом адресе. */
export function tipScope(pathname: string): TipScope {
  if (pathname === '/chat' || pathname.startsWith('/chat/')) return 'chat';
  if (pathname === '/settings' || pathname.startsWith('/settings/')) return 'settings';
  return 'any';
}

/**
 * Следующий совет: случайный из набора, но не тот же, что только что звучал, —
 * повтор подряд читается как зависание. `random` — внешний, чтобы проверка не
 * зависела от удачи.
 */
export function pickTip(
  scope: TipScope,
  previous?: string,
  random: () => number = Math.random,
): string {
  const keys = TIP_KEYS[scope];
  const pool = keys.length > 1 ? keys.filter((key) => key !== previous) : keys;
  const index = Math.min(pool.length - 1, Math.floor(random() * pool.length));
  return pool[index] ?? keys[0] ?? 'me';
}
