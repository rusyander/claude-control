import type { PushDevice } from '@claude-control/contracts';
import type { AppState } from './app-store.types.ts';

/**
 * Телефоны, которым уходят уведомления.
 *
 * Ключ — сам push-токен: он выдан конкретной установке приложения и меняется
 * при переустановке. Своего идентификатора устройству не заводим, потому что он
 * ничего не добавил бы: сервис Expo всё равно отвечает про токен.
 */

/** Сколько устройств помним. Больше — это уже не «мои телефоны», а мусор. */
const MAX_DEVICES = 10;

export function getPushDevices(state: AppState): PushDevice[] {
  return state.pushDevices ?? [];
}

/**
 * Зарегистрировать телефон. Повторная регистрация того же токена не плодит
 * запись, а обновляет её: приложение шлёт токен при каждом запуске, и без этого
 * список рос бы одинаковыми строками.
 */
export function addPushDevice(state: AppState, device: PushDevice): PushDevice[] {
  const rest = getPushDevices(state).filter((item) => item.token !== device.token);
  state.pushDevices = [device, ...rest].slice(0, MAX_DEVICES);
  return state.pushDevices;
}

/** Устройство отвязали руками или сервис ответил, что токен мёртв. */
export function removePushDevice(state: AppState, token: string): boolean {
  const before = getPushDevices(state);
  const after = before.filter((item) => item.token !== token);
  if (after.length === before.length) return false;
  state.pushDevices = after;
  return true;
}
