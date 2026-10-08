import * as Notifications from 'expo-notifications';

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
