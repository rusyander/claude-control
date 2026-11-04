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
const WINDOW_BAR_COLOR: Record<'dark' | 'light', string> = {
  light: '#ffffff',
  dark: '#16191f',
};

/** Ставит цвет заголовка окна под тему; метки нет — ставить некуда. */
export function applyWindowBar(theme: 'dark' | 'light'): void {
  document
    .querySelector('meta[name="theme-color"]')
    ?.setAttribute('content', WINDOW_BAR_COLOR[theme]);
}

/** То, что нужно от i18next: текущий язык и его смена. */
export interface LanguageSwitch {
  language: string;
  changeLanguage(language: string): Promise<unknown>;
}

/** Номер последней смены языка на корне: запоздавший ответ старой смены не трогает `lang`. */
const latestSwitch = new WeakMap<object, number>();

/**
 * Сменить язык интерфейса и отметить его в `lang` корня — ПОСЛЕ того, как словарь
 * загружен. Английский словарь едет отдельным чанком, и всё это время текст на
 * экране русский: `lang="en"` раньше времени обманывал читалку экрана и проверку
 * языка в съёмке справки.
 */
export async function applyLanguage(
  i18n: LanguageSwitch,
  language: string,
  root: { lang: string },
): Promise<void> {
  const ticket = (latestSwitch.get(root) ?? 0) + 1;
  latestSwitch.set(root, ticket);
  if (i18n.language !== language) {
    try {
      await i18n.changeLanguage(language);
    } catch {
      // Словарь не загрузился — текст остался прежним, и lang остаётся прежним.
      return;
    }
  }
  if (latestSwitch.get(root) === ticket) root.lang = language;
}
