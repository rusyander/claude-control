/**
 * `installed` — панель уже открыта в своём окне; `available` — браузер готов
 * установить её по кнопке; `unavailable` — браузер установку не предлагает
 * (Firefox, Safari или приложение уже стоит, а открыта вкладка).
 */
export type InstallAppState = 'installed' | 'available' | 'unavailable';

/** Событие `beforeinstallprompt` — его нет в стандартных типах DOM. */
export interface InstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}
