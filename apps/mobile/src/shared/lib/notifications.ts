import { useEffect, useRef } from 'react';
import * as Notifications from 'expo-notifications';
import Constants from 'expo-constants';
import { Platform } from 'react-native';
import { api } from '../api/client';
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

const CHANNEL_ID = 'runs';

/** Показывать уведомление, даже когда приложение открыто: иначе оно молчит. */
Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowBanner: true,
    shouldShowList: true,
    shouldPlaySound: true,
    shouldSetBadge: false,
  }),
});

export interface PushRegistration {
  token: string;
  /** Почему токена нет — это и есть ответ пользователю на экране настроек. */
  problem?: string;
}

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

/**
 * Получить push-токен и отдать его панели. Отказ здесь — не авария: приложение
 * продолжает работать, просто без уведомлений при закрытом экране.
 */
export async function registerForPush(label: string): Promise<PushRegistration> {
  await ensureChannel();

  const existing = await Notifications.getPermissionsAsync();
  let status = existing.status;
  if (status !== 'granted') {
    const asked = await Notifications.requestPermissionsAsync();
    status = asked.status;
  }
  if (status !== 'granted') {
    return { token: '', problem: dict().push.denied };
  }

  // Идентификатор проекта EAS. Без него сервис Expo не выдаёт токен вовсе —
  // и это единственный шаг, который может сделать только владелец аккаунта.
  const projectId =
    Constants.expoConfig?.extra?.eas?.projectId ?? Constants.easConfig?.projectId ?? '';
  if (!projectId) {
    return {
      token: '',
      problem: dict().push.noProjectId,
    };
  }

  try {
    const { data } = await Notifications.getExpoPushTokenAsync({ projectId });
    await api.post('/remote/devices', {
      token: data,
      platform: Platform.OS === 'ios' ? 'ios' : 'android',
      label,
      // Время регистрации ставит сервер своими часами — из тела он его не читает.
    });
    return { token: data };
  } catch (error) {
    return {
      token: '',
      problem: error instanceof Error ? error.message : dict().push.noToken,
    };
  }
}

/** Местное уведомление — когда удалённый путь ещё не настроен. */
export async function notifyLocally(
  title: string,
  body: string,
  data?: Record<string, string>,
): Promise<void> {
  await Notifications.scheduleNotificationAsync({
    // `data` — тот же вид, что у удалённого уведомления: нажатие ведёт в разговор.
    content: { title, body, sound: 'default', ...(data ? { data } : {}) },
    trigger: null,
  });
}

/**
 * Нажатие на уведомление — в разговор, о котором оно. Последний ответ хранит
 * сама система: так нажатие доходит и тогда, когда приложение им же и
 * запускалось с нуля. Один и тот же ответ не открывается дважды — после
 * перемонтирования корня он бы снова увёл человека с того места, где он есть.
 */
export function useNotificationOpen(open: (data: unknown) => void, ready: boolean): void {
  const response = Notifications.useLastNotificationResponse();
  const handled = useRef('');
  useEffect(() => {
    if (!ready || !response) return;
    const id = response.notification.request.identifier;
    if (handled.current === id) return;
    handled.current = id;
    open(response.notification.request.content.data);
    void Notifications.clearLastNotificationResponseAsync().catch(() => undefined);
  }, [ready, response, open]);
}
