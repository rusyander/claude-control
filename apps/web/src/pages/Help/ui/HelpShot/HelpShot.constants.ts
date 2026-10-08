import type { HelpShotSide } from '../help-kit.types';

/** Чей экран на кадре — первое слово подписи. */
export const SIDE_KEYS: Record<HelpShotSide, string> = {
  panel: 'help.shots.sidePanel',
  platform: 'help.shots.sidePlatform',
  // Экран приложения на телефоне: снят с эмулятора Android, у приложения одна
  // (тёмная) тема, поэтому кадр узкий и от темы панели не зависит.
  phone: 'help.shots.sidePhone',
};
