import { useCallback, useEffect, useSyncExternalStore } from 'react';
import Constants from 'expo-constants';
import { Platform } from 'react-native';
import * as SecureStore from 'expo-secure-store';

/**
 * Куда ходить и чем представляться. Единственное состояние, которое приложение
 * держит на диске само, — всё остальное живёт на машине с панелью.
 *
 * Токен лежит в SecureStore (Keystore/Keychain), а не в обычном хранилище: этим
 * токеном открывается API, который отдаёт секреты и заводит хуки. Адрес рядом с
 * ним по той же причине — вместе они пара, и разносить их по разным хранилищам
 * значило бы получить состояние, где есть половина.
 */

const KEY_URL = 'panel.url';
const KEY_TOKEN = 'panel.token';

/**
 * Хранилище пары. На телефоне — SecureStore; в веб-сборке Expo (ею снимают
 * экраны приложения для проверки) у SecureStore нет реализации вовсе, и чтение
 * падало исключением — приложение оставалось белым листом. Там — sessionStorage:
 * пара живёт до закрытия вкладки (F5 её не теряет), а не вечно в localStorage,
 * где токен полного доступа к машине читал бы любой скрипт того же origin и
 * после того, как вкладку закрыли (F-22). Адрес — туда же: пара неделима.
 */
const web = (): Storage | undefined => globalThis.sessionStorage;

/**
 * Пару, которую прежняя веб-сборка оставила в localStorage, переносим во
 * вкладку и стираем там — иначе токен лежал бы на диске и после обновления.
 */
function takeLegacy(key: string): string | null {
  const legacy = globalThis.localStorage;
  const value = legacy?.getItem(key) ?? null;
  if (value === null) return null;
  legacy?.removeItem(key);
  if (web()?.getItem(key) === null) web()?.setItem(key, value);
  return web()?.getItem(key) ?? value;
}

const store = {
  get: (key: string): Promise<string | null> =>
    Platform.OS === 'web'
      ? Promise.resolve(takeLegacy(key) ?? web()?.getItem(key) ?? null)
      : SecureStore.getItemAsync(key),
  set: (key: string, value: string): Promise<void> =>
    Platform.OS === 'web'
      ? Promise.resolve(web()?.setItem(key, value))
      : SecureStore.setItemAsync(key, value),
  remove: (key: string): Promise<void> => {
    if (Platform.OS !== 'web') return SecureStore.deleteItemAsync(key);
    web()?.removeItem(key);
    globalThis.localStorage?.removeItem(key);
    return Promise.resolve();
  },
};

/**
 * Адрес, вшитый в сборку (`MOBILE_DEFAULT_URL` при `pnpm mobile:apk`). Нужен,
 * когда APK отдают другому человеку: поле адреса уже заполнено, остаётся токен.
 * Токен так не передаётся никогда — он равен полному доступу к машине.
 */
export function bundledUrl(): string {
  const value = Constants.expoConfig?.extra?.defaultPanelUrl;
  return typeof value === 'string' ? value.trim() : '';
}

export interface Connection {
  /** Базовый адрес API, без хвостового слэша, например `https://mac.tail.ts.net`. */
  url: string;
  token: string;
  /** Прочитано ли хранилище — до этого момента «не настроено» ещё не факт. */
  ready: boolean;
}

let state: Connection = { url: '', token: '', ready: false };
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Нормализация адреса: хвостовой слэш ломает склейку путей, схему добавляем. */
export function normalizeUrl(raw: string): string {
  const value = raw.trim().replace(/\/+$/, '');
  if (!value) return '';
  if (/^https?:\/\//i.test(value)) return value;
  return `http://${value}`;
}

export async function loadConnection(): Promise<Connection> {
  const [url, token] = await Promise.all([store.get(KEY_URL), store.get(KEY_TOKEN)]);
  state = { url: url ?? '', token: token ?? '', ready: true };
  emit();
  return state;
}

export async function saveConnection(url: string, token: string): Promise<void> {
  const normalized = normalizeUrl(url);
  await Promise.all([store.set(KEY_URL, normalized), store.set(KEY_TOKEN, token.trim())]);
  state = { url: normalized, token: token.trim(), ready: true };
  emit();
}

export async function clearConnection(): Promise<void> {
  await Promise.all([store.remove(KEY_URL), store.remove(KEY_TOKEN)]);
  state = { url: '', token: '', ready: true };
  emit();
}

/** Синхронный доступ для слоя запросов — он вызывается вне React. */
export function currentConnection(): Connection {
  return state;
}

export function isConfigured(connection: Connection = state): boolean {
  return Boolean(connection.url);
}

export function useConnection(): Connection {
  const value = useSyncExternalStore(subscribe, currentConnection, currentConnection);
  useEffect(() => {
    if (!value.ready) void loadConnection();
  }, [value.ready]);
  return value;
}

/** Готовые действия для экрана настроек — чтобы он не знал про хранилище. */
export function useConnectionActions(): {
  save: (url: string, token: string) => Promise<void>;
  clear: () => Promise<void>;
} {
  const save = useCallback((url: string, token: string) => saveConnection(url, token), []);
  const clear = useCallback(() => clearConnection(), []);
  return { save, clear };
}
