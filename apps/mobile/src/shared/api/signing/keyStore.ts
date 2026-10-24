import { Platform } from 'react-native';
import * as SecureStore from 'expo-secure-store';
import { getRandomBytes } from 'expo-crypto';
import { fromBase64Url, toBase64Url } from '@agentdeck/contracts/phone-signing';
import { keyFromSeed, type PhoneKey } from './signing';

/**
 * Ключ подписи — свой для каждого спаренного компьютера (по номеру машины):
 * отзыв на одном компьютере не трогает другие, и подпись для одного там не
 * подойдёт уже по номеру.
 *
 * Зерно лежит в SecureStore (Android Keystore шифрует запись, из резервной
 * копии записи исключены, удаление приложения их стирает; iOS — только на этом
 * устройстве, после разблокировки). В веб-сборке Expo ключа нет вовсе: окно
 * браузера — ровно то место, которому режим подписи не доверяет.
 */

const keyName = (machineId: string): string =>
  `signing.seed.${machineId.replace(/[^A-Za-z0-9._-]/g, '_')}`;

const OPTIONS: SecureStore.SecureStoreOptions = {
  keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
};

const cache = new Map<string, PhoneKey | null>();

export const signingSupported = (): boolean => Platform.OS !== 'web';

/** Ключ телефона для этого компьютера; нет — undefined (подписи не будет). */
export async function loadKey(machineId: string): Promise<PhoneKey | undefined> {
  if (!machineId || !signingSupported()) return undefined;
  const known = cache.get(machineId);
  if (known !== undefined) return known ?? undefined;
  const stored = await SecureStore.getItemAsync(keyName(machineId), OPTIONS).catch(() => null);
  const seed = stored ? fromBase64Url(stored) : undefined;
  const key = seed && seed.length === 32 ? keyFromSeed(seed) : undefined;
  cache.set(machineId, key ?? null);
  return key;
}

/**
 * Новый ключ для компьютера — вместо прежнего, если он был (прежний отозван
 * или стёрт). Зерно — из системного генератора (`expo-crypto`).
 */
export async function createKey(machineId: string): Promise<PhoneKey> {
  if (!signingSupported()) throw new Error('signing-unsupported');
  const seed = getRandomBytes(32);
  await SecureStore.setItemAsync(keyName(machineId), toBase64Url(seed), OPTIONS);
  const key = keyFromSeed(seed);
  cache.set(machineId, key);
  return key;
}

/** Забыть ключ этого компьютера на телефоне (сама панель узнает об этом по отзыву). */
export async function forgetKey(machineId: string): Promise<void> {
  cache.delete(machineId);
  if (!signingSupported()) return;
  await SecureStore.deleteItemAsync(keyName(machineId), OPTIONS).catch(() => undefined);
}

/** Одноразовое число подписи: 16 случайных байт. */
export const freshNonce = (): string => toBase64Url(getRandomBytes(16));
