/**
 * Тема оформления ОС в момент вызова. Подписка на её смену живёт в самом
 * провайдере: здесь только снимок, чтобы ветка «system» читалась одной строкой.
 */
export function systemTheme(): 'dark' | 'light' {
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

/**
 * Цвет заголовка окна установленной панели — поверхность активной темы
 * (`--color-surface` в `global.scss`). Прежний фиолетовый #4f46e5 из манифеста
 * горел полосой над интерфейсом (владелец 22.10.2026); окно должно продолжать
 * интерфейс, а не спорить с ним.
 */
export const WINDOW_BAR_COLOR: Record<'dark' | 'light', string> = {
  light: '#ffffff',
  dark: '#16191f',
};

/** Ставит цвет заголовка окна под тему; метки нет — ставить некуда. */
export function applyWindowBar(theme: 'dark' | 'light'): void {
  document
    .querySelector('meta[name="theme-color"]')
    ?.setAttribute('content', WINDOW_BAR_COLOR[theme]);
}
