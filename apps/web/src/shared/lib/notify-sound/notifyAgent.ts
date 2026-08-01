import { getChatPrefs } from '@shared/lib/chat-prefs';
import { playNotification, type NotifyKind } from './playNotification';

/**
 * Единственная точка, где сходятся «звук включён» и «насколько громко». Раньше
 * каждый повод для сигнала сам спрашивал настройку — стоило добавить громкость,
 * и её пришлось бы протаскивать по всем вызовам; теперь звонит только этот
 * помощник, а вызывающему достаточно знать повод.
 */
export function notifyAgent(kind: NotifyKind): void {
  const prefs = getChatPrefs();
  if (!prefs.sound) return;
  playNotification(kind, prefs.soundVolume);
}
