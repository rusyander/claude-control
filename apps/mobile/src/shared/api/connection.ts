import { useCallback, useEffect, useSyncExternalStore } from 'react';
import Constants from 'expo-constants';
import { Platform } from 'react-native';
import * as SecureStore from 'expo-secure-store';
import type { MachineIdentity } from '@agentdeck/contracts';
import {
  applyIdentity,
  parsePanels,
  removeEntry,
  renameEntry,
  upsertByUrl,
  type PanelEntry,
} from './panels';

/**
 * Куда ходить и чем представляться. Единственное состояние, которое приложение
 * держит на диске само, — всё остальное живёт на машинах с панелью.
 *
 * Телефон бывает спарен с несколькими компьютерами: список лежит одной записью,
 * токен каждого — своим ключом, и выбран всегда ровно один. Слой запросов знает
 * только выбранный (`url` + `token`), поэтому смена компьютера — это смена пары,
 * а не новые аргументы у каждого запроса.
 *
 * Токены лежат в SecureStore (Keystore/Keychain), а не в обычном хранилище: токеном
 * открывается API, который отдаёт секреты и заводит хуки. Список с адресами рядом
 * с ними по той же причине — адрес без токена половина пары.
 */

const KEY_PANELS = 'panels.v1';
const KEY_ACTIVE = 'panels.active';
const tokenKey = (id: string): string => `panels.token.${id}`;
/** Пара одной панели — как её хранили до списка компьютеров; переносится при запуске. */
const LEGACY_URL = 'panel.url';
const LEGACY_TOKEN = 'panel.token';

/**
 * Хранилище пары. На телефоне — SecureStore; в веб-сборке Expo (ею снимают
 * экраны приложения для проверки) у SecureStore нет реализации вовсе, и чтение
 * падало исключением — приложение оставалось белым листом. Там — sessionStorage:
 * пара живёт до закрытия вкладки (F5 её не теряет), а не вечно в localStorage,
 * где токен полного доступа к машине читал бы любой скрипт того же origin и
 * после того, как вкладку закрыли (F-22).
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
  /** Базовый адрес API выбранного компьютера, без хвостового слэша. */
  url: string;
  token: string;
  /** Прочитано ли хранилище — до этого момента «не настроено» ещё не факт. */
  ready: boolean;
  /** Все спаренные компьютеры, в порядке спаривания. */
  panels: PanelEntry[];
  /** Выбранный; пусто — не спарен ни с одним. */
  activeId: string;
}

const EMPTY: Connection = { url: '', token: '', ready: false, panels: [], activeId: '' };
let state: Connection = EMPTY;
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

/** Записать список и выбранный, прочитать токен выбранного и оповестить экраны. */
async function commit(panels: PanelEntry[], activeId: string, token?: string): Promise<void> {
  await Promise.all([
    store.set(KEY_PANELS, JSON.stringify(panels)),
    activeId ? store.set(KEY_ACTIVE, activeId) : store.remove(KEY_ACTIVE),
  ]);
  const active = panels.find((entry) => entry.id === activeId);
  const activeToken = active ? (token ?? (await store.get(tokenKey(active.id))) ?? '') : '';
  state = {
    url: active?.url ?? '',
    token: activeToken,
    ready: true,
    panels,
    activeId: active?.id ?? '',
  };
  emit();
}

/** Пара одной панели из прежних версий становится первым компьютером списка. */
async function adoptLegacy(): Promise<PanelEntry[]> {
  const [url, token] = await Promise.all([store.get(LEGACY_URL), store.get(LEGACY_TOKEN)]);
  if (!url) return [];
  const { list, id } = upsertByUrl([], url);
  await store.set(tokenKey(id), token ?? '');
  await store.set(KEY_PANELS, JSON.stringify(list));
  await store.set(KEY_ACTIVE, id);
  await Promise.all([store.remove(LEGACY_URL), store.remove(LEGACY_TOKEN)]);
  return list;
}

export async function loadConnection(): Promise<Connection> {
  let panels = parsePanels(await store.get(KEY_PANELS));
  if (panels.length === 0) panels = await adoptLegacy();
  const stored = (await store.get(KEY_ACTIVE)) ?? '';
  const activeId = panels.some((entry) => entry.id === stored) ? stored : (panels[0]?.id ?? '');
  await commit(panels, activeId);
  return state;
}

/**
 * Спаривание: компьютер с тем же адресом обновляет токен, новый добавляется в
 * список. В обоих случаях он становится выбранным. Возвращает его id.
 */
export async function saveConnection(url: string, token: string): Promise<string> {
  const normalized = normalizeUrl(url);
  const { list, id } = upsertByUrl(state.panels, normalized);
  await store.set(tokenKey(id), token.trim());
  await commit(list, id, token.trim());
  return id;
}

/** Выбрать другой компьютер. Неизвестный id не меняет ничего. */
export async function switchPanel(id: string): Promise<void> {
  if (!state.panels.some((entry) => entry.id === id)) return;
  await commit(state.panels, id);
}

/**
 * Машина назвала себя (`/api/system`). Тот же номер под другой записью — тот
 * же компьютер по новому адресу: записи склеиваются, токен свежей переезжает.
 */
export async function describePanel(id: string, identity: MachineIdentity): Promise<void> {
  const { list, id: kept, dropped } = applyIdentity(state.panels, id, identity);
  const unchanged = JSON.stringify(list) === JSON.stringify(state.panels);
  if (unchanged) return;
  let token: string | undefined;
  if (dropped) {
    token = (await store.get(tokenKey(dropped))) ?? '';
    await store.set(tokenKey(kept), token);
    await store.remove(tokenKey(dropped));
  }
  const activeId = state.activeId === dropped ? kept : state.activeId;
  await commit(list, activeId, activeId === kept ? token : undefined);
}

export async function renamePanel(id: string, name: string): Promise<void> {
  await commit(renameEntry(state.panels, id, name), state.activeId, state.token);
}

/** Забыть компьютер вместе с токеном. Был выбран — выбранным станет первый оставшийся. */
export async function removePanel(id: string): Promise<void> {
  const { list, activeId } = removeEntry(state.panels, id, state.activeId);
  await store.remove(tokenKey(id));
  await commit(list, activeId);
}

/** «Отключить» — забыть выбранный компьютер. */
export async function clearConnection(): Promise<void> {
  if (state.activeId) await removePanel(state.activeId);
}

/** Синхронный доступ для слоя запросов — он вызывается вне React. */
export function currentConnection(): Connection {
  return state;
}

/** Выбранный компьютер целиком: имя, номер, система. */
export function activePanel(connection: Connection = state): PanelEntry | undefined {
  return connection.panels.find((entry) => entry.id === connection.activeId);
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
  save: (url: string, token: string) => Promise<string>;
  clear: () => Promise<void>;
} {
  const save = useCallback((url: string, token: string) => saveConnection(url, token), []);
  const clear = useCallback(() => clearConnection(), []);
  return { save, clear };
}
