import { useEffect, useRef } from 'react';
import { Platform } from 'react-native';
import * as Notifications from 'expo-notifications';

/** Показывать уведомление, даже когда приложение открыто: иначе оно молчит. */
Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowBanner: true,
    shouldShowList: true,
    shouldPlaySound: true,
    shouldSetBadge: false,
  }),
});

/**
 * В веб-сборке (ею проверяют экраны) у модуля нет последнего ответа вовсе: вызов
 * бросал исключение, и приложение оставалось белым листом. Платформа не меняется
 * за жизнь процесса, поэтому подмена хука на уровне модуля порядок хуков не ломает.
 */
const useLastResponse: () => Notifications.NotificationResponse | null | undefined =
  Platform.OS === 'web' ? () => null : Notifications.useLastNotificationResponse;

/**
 * Нажатие на уведомление — в разговор, о котором оно. Последний ответ хранит
 * сама система: так нажатие доходит и тогда, когда приложение им же и
 * запускалось с нуля. Один и тот же ответ не открывается дважды — после
 * перемонтирования корня он бы снова увёл человека с того места, где он есть.
 */
export function useNotificationOpen(open: (data: unknown) => void, ready: boolean): void {
  const response = useLastResponse();
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
