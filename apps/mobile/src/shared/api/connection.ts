import { useCallback, useEffect, useSyncExternalStore } from 'react';
import Constants from 'expo-constants';
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
  const [url, token] = await Promise.all([
    SecureStore.getItemAsync(KEY_URL),
    SecureStore.getItemAsync(KEY_TOKEN),
  ]);
  state = { url: url ?? '', token: token ?? '', ready: true };
  emit();
  return state;
}

export async function saveConnection(url: string, token: string): Promise<void> {
  const normalized = normalizeUrl(url);
  await Promise.all([
    SecureStore.setItemAsync(KEY_URL, normalized),
    SecureStore.setItemAsync(KEY_TOKEN, token.trim()),
  ]);
  state = { url: normalized, token: token.trim(), ready: true };
  emit();
}

export async function clearConnection(): Promise<void> {
  await Promise.all([SecureStore.deleteItemAsync(KEY_URL), SecureStore.deleteItemAsync(KEY_TOKEN)]);
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
