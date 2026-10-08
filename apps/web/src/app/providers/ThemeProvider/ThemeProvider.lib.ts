/**
 * Тема оформления ОС в момент вызова. Подписка на её смену живёт в самом
 * провайдере: здесь только снимок, чтобы ветка «system» читалась одной строкой.
 */
export function systemTheme(): 'dark' | 'light' {
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}
