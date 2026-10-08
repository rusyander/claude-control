import { Platform } from 'react-native';
import * as Notifications from 'expo-notifications';
import { dict } from '../config/i18n';

/**
 * Уведомления о том, что работа закончилась или встала.
 *
 * Два пути, и оба нужны. УДАЛЁННЫЙ (Expo Push) работает при закрытом
 * приложении — ради него всё и затевалось, но он требует токена, а токен
 * выдаётся только проекту с идентификатором EAS и настроенным FCM. Пока их нет,
 * работает МЕСТНЫЙ путь: приложение, висящее в фоне, само показывает
 * уведомление, когда поток прогона принёс терминальное событие. Второе не
 * заменяет первое — оно лишь не оставляет человека совсем без сигнала.
 */

export const CHANNEL_ID = 'runs';

/**
 * Канал Android. Без него уведомления приходят беззвучно и не всплывают, а
 * человек узнаёт о них, только сам открыв шторку.
 */
export async function ensureChannel(): Promise<void> {
  if (Platform.OS !== 'android') return;
  await Notifications.setNotificationChannelAsync(CHANNEL_ID, {
    name: dict().push.channel,
    importance: Notifications.AndroidImportance.HIGH,
    vibrationPattern: [0, 250, 250, 250],
    lockscreenVisibility: Notifications.AndroidNotificationVisibility.PUBLIC,
  });
}
