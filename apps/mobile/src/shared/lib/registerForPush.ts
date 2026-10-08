import { ensureChannel } from './ensureChannel';
import * as Notifications from 'expo-notifications';
import { dict } from '../config/i18n';
import Constants from 'expo-constants';
import { api } from '../api/client';
import { Platform } from 'react-native';

export interface PushRegistration {
  token: string;
  /** Почему токена нет — это и есть ответ пользователю на экране настроек. */
  problem?: string;
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
