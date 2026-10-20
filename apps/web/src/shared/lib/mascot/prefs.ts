import { useSyncExternalStore } from 'react';
import type { MascotPrefs } from './prefs.types';

/** Ключ в localStorage: настройка этого браузера, сервер о маскоте не знает. */
export const MASCOT_PREFS_KEY = 'agentdeck.mascot';

export const DEFAULT_MASCOT_PREFS: MascotPrefs = { enabled: true, chatty: true, greeted: false };

/**
 * Разбор сохранённого значения. Битая строка или чужая форма — не повод
 * ломать каркас: берём умолчания и то, что из сохранённого узнаётся.
 */
export function parseMascotPrefs(raw: string | null): MascotPrefs {
  if (!raw) return DEFAULT_MASCOT_PREFS;
  try {
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== 'object') return DEFAULT_MASCOT_PREFS;
    const record = value as Record<string, unknown>;
    const flag = (key: keyof MascotPrefs): boolean =>
      typeof record[key] === 'boolean' ? (record[key] as boolean) : DEFAULT_MASCOT_PREFS[key];
    return { enabled: flag('enabled'), chatty: flag('chatty'), greeted: flag('greeted') };
  } catch {
    return DEFAULT_MASCOT_PREFS;
  }
}

const listeners = new Set<() => void>();
let cached: { raw: string | null; prefs: MascotPrefs } | undefined;

function read(): MascotPrefs {
  const raw = typeof localStorage === 'undefined' ? null : localStorage.getItem(MASCOT_PREFS_KEY);
  // Один и тот же объект, пока строка не менялась: `useSyncExternalStore`
  // сравнивает снимки по ссылке и иначе перерисовывал бы без конца.
  if (cached?.raw !== raw) cached = { raw, prefs: parseMascotPrefs(raw) };
  return cached.prefs;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  // Вторая вкладка выключила маскота — эта узнаёт из события `storage`.
  const onStorage = (event: StorageEvent): void => {
    if (event.key === MASCOT_PREFS_KEY) listener();
  };
  window.addEventListener('storage', onStorage);
  return () => {
    listeners.delete(listener);
    window.removeEventListener('storage', onStorage);
  };
}

export function getMascotPrefs(): MascotPrefs {
  return read();
}

export function setMascotPrefs(patch: Partial<MascotPrefs>): void {
  localStorage.setItem(MASCOT_PREFS_KEY, JSON.stringify({ ...read(), ...patch }));
  listeners.forEach((listener) => listener());
}

/** Настройки маскота с подпиской: переключатель в «Настройках» виден сразу везде. */
export function useMascotPrefs(): MascotPrefs {
  return useSyncExternalStore(subscribe, read, () => DEFAULT_MASCOT_PREFS);
}
