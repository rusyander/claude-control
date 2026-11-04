import { existsSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Кеш слота по разговорам на постоянном адресе (этап 10, зона C4; перенесено из панели
 * `local-models/slot-store.ts` вместе с `prepare(session)` шлюза). У сервера модели один слот
 * (`-np 1`): разговор сменился — кеш прежнего уходит в файл каталога `--slot-save-path` (если
 * стоит того), кеш нового поднимается из файла, а нет файла — слот стирается: чужой префикс новому
 * чату не достаётся.
 *
 * Держатель слота привязан к адресу сервера: ядро поднимает сервер аренды на новом порту каждый
 * раз, так что новый адрес = пустой слот. Запись по простою перед сном сервера панель вела сама;
 * у удержания ядра сна нет (`--sleep-idle-seconds` не задаётся) — её здесь нет.
 *
 * Лежит в платформе, а не у маршрута `local:own`: файлы кеша читает и стирает только платформа
 * (depcruise `core-io-only-in-platform`), маршрут получает готовый `SlotCache`.
 */

/** Меньше этого кеш не сохраняется: перечитать короткий промпт дешевле записи. */
export const SAVE_MIN_TOKENS = 8_192;
export const MAX_SLOT_FILES = 6;
export const MAX_SLOT_BYTES = 32 * 1024 ** 3;
export const MAX_SLOT_AGE_MS = 3 * 24 * 60 * 60_000;
export const SLOT_IO_TIMEOUT_MS = 120_000;
/** Сброс слота — не дольше трёх секунд: запрос человека ждёт его. */
const ERASE_TIMEOUT_MS = 3_000;

/** Сервер за адресом сейчас: адрес, модель (её имя роутер llama-server читает в `?model=`), запуск. */
export interface SlotTarget {
  origin: string;
  model: string;
  /** Запуск, с которого снят кеш (модель + аргументы): другой — файл не годится. */
  shape: string;
  /** Каталог `--slot-save-path`; нет — сервер действий над слотом не выполняет. */
  dir: string | undefined;
}

interface Meta {
  session: string;
  shape: string;
  tokens: number;
  savedAt: number;
}

export type SwitchResult = 'kept' | 'restored' | 'erased' | 'skipped';

export interface SlotCacheOptions {
  fetchImpl?: typeof fetch;
  now?: () => number;
  note?: (event: string, data: Record<string, unknown>) => void;
}

/** Имя файла из номера разговора: llama.cpp принимает только имя без пути. */
export function slotFileOf(session: string): string {
  return `${session.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 96)}.bin`;
}

export interface SlotCache {
  /**
   * Запрос разговора `session` вот-вот уйдёт серверу `target`; `undefined` — запрос без метки
   * (проба, замер): кеш разговора в слоте — на диск, держатель неизвестен, слот не стирается.
   * Не бросает: сбой слота — не повод отказывать запросу.
   */
  prepare(session: string | undefined, target: SlotTarget): Promise<SwitchResult>;
  /** Сколько токенов промпта у ушедшего запроса: столько окажется в кеше. */
  noteTokens(tokens: number): void;
}

export function createSlotCache(options: SlotCacheOptions = {}): SlotCache {
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now ?? Date.now;
  const note = options.note ?? (() => undefined);
  let holder: { session: string; origin: string; tokens: number } | undefined;
  let chain: Promise<unknown> = Promise.resolve();
  const serial = <T>(work: () => Promise<T>): Promise<T> => {
    const next = chain.then(work, work);
    chain = next.catch(() => undefined);
    return next;
  };

  async function action(
    target: SlotTarget,
    name: 'save' | 'restore' | 'erase',
    filename?: string,
  ): Promise<number> {
    const query = `action=${name}&model=${encodeURIComponent(target.model)}`;
    const response = await fetchImpl(`${target.origin}/slots/0?${query}`, {
      method: 'POST',
      ...(filename
        ? {
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ filename }),
          }
        : {}),
      signal: AbortSignal.timeout(name === 'erase' ? ERASE_TIMEOUT_MS : SLOT_IO_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`slot ${name}: HTTP ${response.status}`);
    const body = (await response.json()) as Record<string, unknown>;
    const count = Number(body[`n_${name === 'erase' ? 'erased' : `${name}d`}`] ?? 0);
    return Number.isFinite(count) ? count : 0;
  }

  const metaPath = (dir: string, session: string): string =>
    join(dir, slotFileOf(session).replace(/\.bin$/, '.json'));

  function readMeta(dir: string, session: string): Meta | undefined {
    try {
      const meta = JSON.parse(readFileSync(metaPath(dir, session), 'utf8')) as Meta;
      return existsSync(join(dir, slotFileOf(session))) ? meta : undefined;
    } catch {
      return undefined;
    }
  }

  async function save(owner: NonNullable<typeof holder>, target: SlotTarget): Promise<void> {
    if (!target.dir || owner.tokens < SAVE_MIN_TOKENS) return;
    try {
      const tokens = await action(target, 'save', slotFileOf(owner.session));
      const meta: Meta = { session: owner.session, shape: target.shape, tokens, savedAt: now() };
      writeFileSync(metaPath(target.dir, owner.session), JSON.stringify(meta));
      note('local.slot', { state: 'saved', session: owner.session, tokens });
      prune(target.dir, target.shape);
    } catch (error) {
      note('local.slot', { state: 'save-failed', reason: String(error) });
    }
  }

  /** Файлы чужого запуска, устаревшие, без описания и сверх предела — прочь, с самых давних. */
  function prune(dir: string, shape: string): void {
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      return;
    }
    const oldest = now() - MAX_SLOT_AGE_MS;
    const described = new Set<string>();
    let entries: { session: string; bytes: number; savedAt: number; stale: boolean }[] = [];
    for (const name of names) {
      if (!name.endsWith('.json')) continue;
      try {
        const meta = JSON.parse(readFileSync(join(dir, name), 'utf8')) as Meta;
        const bin = join(dir, slotFileOf(meta.session));
        const bytes = existsSync(bin) ? statSync(bin).size : 0;
        described.add(slotFileOf(meta.session));
        entries.push({
          session: meta.session,
          bytes,
          savedAt: meta.savedAt,
          stale: meta.shape !== shape || bytes === 0 || !(meta.savedAt >= oldest),
        });
      } catch {
        rmSync(join(dir, name), { force: true });
      }
    }
    const drop = (session: string): void => {
      rmSync(join(dir, slotFileOf(session)), { force: true });
      rmSync(metaPath(dir, session), { force: true });
    };
    for (const name of names)
      if (name.endsWith('.bin') && !described.has(name)) rmSync(join(dir, name), { force: true });
    for (const entry of entries.filter((item) => item.stale)) drop(entry.session);
    entries = entries.filter((item) => !item.stale).sort((a, b) => b.savedAt - a.savedAt);
    let total = 0;
    entries.forEach((entry, index) => {
      total += entry.bytes;
      if (index >= MAX_SLOT_FILES || total > MAX_SLOT_BYTES) drop(entry.session);
    });
  }

  return {
    prepare: (session, target) =>
      serial(async (): Promise<SwitchResult> => {
        // Сервер сменился (новый адрес) — слот пуст, прежний держатель забыт.
        const owner = holder?.origin === target.origin ? holder : undefined;
        if (session === undefined) {
          if (owner) await save(owner, target);
          holder = undefined;
          return 'skipped';
        }
        if (owner?.session === session) return 'kept';
        if (owner) await save(owner, target);
        const meta = target.dir ? readMeta(target.dir, session) : undefined;
        if (meta && meta.shape === target.shape) {
          try {
            const tokens = await action(target, 'restore', slotFileOf(session));
            holder = { session, origin: target.origin, tokens };
            note('local.slot', { state: 'restored', session, tokens });
            return 'restored';
          } catch (error) {
            note('local.slot', { state: 'restore-failed', reason: String(error) });
          }
        }
        holder = { session, origin: target.origin, tokens: 0 };
        // Чей кеш в слоте, неизвестно (проба, прошлый запуск) — тоже чужой префикс: стереть.
        try {
          await action(target, 'erase');
        } catch {
          // Сервер без каталога слотов или занят: запрос идёт как есть.
        }
        return 'erased';
      }).catch(() => 'skipped' as const),
    noteTokens(tokens) {
      if (holder) holder.tokens = Math.max(holder.tokens, tokens);
    },
  };
}
