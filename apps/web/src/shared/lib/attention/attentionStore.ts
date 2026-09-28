/**
 * Какие поводы человек уже видел (`attention.ts`, ключ повода → когда увиден).
 *
 * Помнится в localStorage: панель открывают заново постоянно (установленное
 * приложение, восстановленная вкладка), и память вкладки на это не годится —
 * после каждого открытия все старые вопросы снова звали бы точкой (владелец
 * 28.09: «• 4» горело всегда). Новый повод получает новый ключ, поэтому память
 * увиденного не глушит его. Записи старше двух недель и сверх лимита уходят сами.
 */

const STORAGE_KEY = 'agentdeck:attention-seen';
/** Сколько помнить увиденное: дольше повод с тем же ключом не живёт. */
const KEEP_MS = 14 * 24 * 60 * 60 * 1000;
/** Сколько ключей держать максимум — свежие важнее. */
const KEEP_COUNT = 500;

const listeners = new Set<() => void>();
let seen: Map<string, number> | undefined;
/** Снимок для useSyncExternalStore: новая ссылка только когда набор менялся. */
let snapshot: ReadonlySet<string> = new Set();

function storage(): Storage | undefined {
  try {
    return typeof localStorage === 'undefined' ? undefined : localStorage;
  } catch {
    return undefined;
  }
}

/** Прочитать и подрезать сохранённое: битое или чужое — как пустое. */
function load(): Map<string, number> {
  const now = Date.now();
  const out = new Map<string, number>();
  try {
    const raw: unknown = JSON.parse(storage()?.getItem(STORAGE_KEY) ?? '{}');
    if (raw && typeof raw === 'object') {
      for (const [key, at] of Object.entries(raw)) {
        if (typeof at === 'number' && now - at < KEEP_MS) out.set(key, at);
      }
    }
  } catch {
    // пусто — значит, ничего не видели
  }
  return out;
}

function state(): Map<string, number> {
  if (!seen) {
    seen = load();
    snapshot = new Set(seen.keys());
  }
  return seen;
}

function save(): void {
  const map = state();
  if (map.size > KEEP_COUNT) {
    const newest = [...map.entries()].sort((a, b) => b[1] - a[1]).slice(0, KEEP_COUNT);
    map.clear();
    for (const [key, at] of newest) map.set(key, at);
  }
  try {
    storage()?.setItem(STORAGE_KEY, JSON.stringify(Object.fromEntries(map)));
  } catch {
    // квота или приватный режим: увиденное проживёт до перезагрузки
  }
  snapshot = new Set(map.keys());
  for (const listener of listeners) listener();
}

export function getSeen(): ReadonlySet<string> {
  state();
  return snapshot;
}

export function subscribeSeen(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Человек увидел эти поводы. */
export function markSeen(keys: readonly string[]): void {
  const map = state();
  const fresh = keys.filter((key) => !map.has(key));
  if (fresh.length === 0) return;
  const now = Date.now();
  for (const key of fresh) map.set(key, now);
  save();
}

/** Забыть увиденное с этим префиксом — у прогона кончился прошлый повод. */
export function forgetSeen(prefixes: readonly string[]): void {
  if (prefixes.length === 0) return;
  const map = state();
  const gone = [...map.keys()].filter((key) => prefixes.some((prefix) => key.startsWith(prefix)));
  if (gone.length === 0) return;
  for (const key of gone) map.delete(key);
  save();
}

/** Человек открыл чат прогона и увидел этот его повод. */
export function dismissAttention(runId: string | undefined, status: string): void {
  if (!runId) return;
  markSeen([`run:${runId}:${status}`]);
}

/** Только для тестов: вернуть хранилище в исходное состояние. */
export function resetSeen(): void {
  seen = new Map();
  storage()?.removeItem(STORAGE_KEY);
  snapshot = new Set();
  for (const listener of listeners) listener();
}
