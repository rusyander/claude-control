import { existsSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { LlamaClient } from './llama-client.ts';

/**
 * Кеш прочитанного промпта на диске (L8, 15.10). У сервера один слот: чужой чат, сон по
 * простою и перезапуск стирают кеш, и следующий ход читает весь промпт заново — замер
 * 15.10 на Qwen3.8 при 22 тыс. токенах: 10,2 с. Слот, сохранённый в файл и восстановленный,
 * дал тот же ход за 41 токен (восстановление 2,2 с, файл 2,26 ГБ); гибридная модель
 * (рекуррентные слои) восстанавливается тоже. Без восстановления кеш в оперативной памяти
 * (`--cache-ram`) после стирания слота не помог — замер тот же.
 *
 * Когда пишется: при смене чата — кеш уходящего, если он длиннее `SAVE_MIN_TOKENS` (короткий
 * дешевле прочитать заново, чем писать гигабайт); перед сном по простою — один раз
 * (`saveIdle`, зовёт сервис). Когда читается: первый запрос чата, чьего кеша в слоте нет,
 * а файл есть и снят с этого же запуска (`shape`: файл модели, окно, тип кеша, шаблон).
 * Файл чужого запуска не читается и удаляется при уборке.
 *
 * Сбой записи или чтения запрос не срывает: тогда слот просто стирается, как раньше.
 */

/** Короче этого кеш не пишется: такой промпт сервер прочтёт за пару секунд. */
export const SAVE_MIN_TOKENS = 8_192;
/** Сколько файлов держать: по одному на чат, самые давние уходят. */
export const MAX_SLOT_FILES = 6;
/** Сколько места занимать: файл — ~100 КБ на токен (замер 15.10), 131072 токена — ~13 ГБ. */
export const MAX_SLOT_BYTES = 32 * 1024 ** 3;
/** Запись и чтение идут очередью сервера — за чужим ходом; дольше этого не ждём. */
export const SLOT_IO_TIMEOUT_MS = 120_000;

export interface SlotStoreDeps {
  dir: string;
  client: Pick<LlamaClient, 'saveSlot' | 'restoreSlot' | 'eraseSlot'>;
  /** Запуск, с которого кеш снят и в который читается; сервера нет — `undefined`. */
  shape: () => string | undefined;
  /** Номер процесса сервера: сменился — слот пуст (перезапуск). */
  pid: () => number | undefined;
  sleeping: () => Promise<boolean>;
  now?: () => number;
  log?: (line: string) => void;
}

interface Meta {
  session: string;
  shape: string;
  tokens: number;
  savedAt: number;
}

export type SwitchResult = 'kept' | 'restored' | 'erased' | 'fresh';

/** Имя файла из номера разговора: llama.cpp принимает только имя без пути. */
export function slotFileOf(session: string): string {
  return `${session.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 96)}.bin`;
}

export function createSlotStore(deps: SlotStoreDeps) {
  const now = deps.now ?? Date.now;
  const log = deps.log ?? (() => undefined);
  /** Чей кеш сейчас в слоте и в каком процессе. */
  let holder: { session: string; pid: number; tokens: number } | undefined;
  /** Кеш в слоте уже лежит на диске (после записи по простою, до следующего запроса). */
  let onDisk = false;
  let lastDoneAt: number | undefined;
  /** Операции со слотом — по одной: запись по простою не встаёт посреди смены чата. */
  let chain: Promise<unknown> = Promise.resolve();
  const serial = <T>(work: () => Promise<T>): Promise<T> => {
    const next = chain.then(work, work);
    chain = next.catch(() => undefined);
    return next;
  };

  const metaPath = (session: string): string =>
    join(deps.dir, slotFileOf(session).replace(/\.bin$/, '.json'));

  function readMeta(session: string): Meta | undefined {
    try {
      const meta = JSON.parse(readFileSync(metaPath(session), 'utf8')) as Meta;
      return existsSync(join(deps.dir, slotFileOf(session))) ? meta : undefined;
    } catch {
      return undefined;
    }
  }

  /** Слот всё ещё держит то, что мы думаем: тот же процесс, сервер не спал. */
  async function currentHolder(): Promise<{ owner: typeof holder; asleep: boolean }> {
    const asleep = await deps.sleeping();
    if (asleep || !holder || holder.pid !== deps.pid()) return { owner: undefined, asleep };
    return { owner: holder, asleep };
  }

  async function save(owner: NonNullable<typeof holder>, shape: string): Promise<boolean> {
    try {
      const tokens = await deps.client.saveSlot(slotFileOf(owner.session), SLOT_IO_TIMEOUT_MS);
      const meta: Meta = { session: owner.session, shape, tokens, savedAt: now() };
      writeFileSync(metaPath(owner.session), JSON.stringify(meta));
      log(`slot saved: ${owner.session} ${tokens} tokens`);
      prune(shape);
      return true;
    } catch (error) {
      log(`slot save failed: ${String(error)}`);
      return false;
    }
  }

  /** Файлы чужого запуска и сверх предела — прочь, начиная с самых давних. */
  function prune(shape: string): void {
    let entries: { session: string; bytes: number; savedAt: number; stale: boolean }[] = [];
    try {
      for (const name of readdirSync(deps.dir)) {
        if (!name.endsWith('.json')) continue;
        try {
          const meta = JSON.parse(readFileSync(join(deps.dir, name), 'utf8')) as Meta;
          const bin = join(deps.dir, slotFileOf(meta.session));
          const bytes = existsSync(bin) ? statSync(bin).size : 0;
          entries.push({
            session: meta.session,
            bytes,
            savedAt: meta.savedAt,
            stale: meta.shape !== shape || bytes === 0,
          });
        } catch {
          rmSync(join(deps.dir, name), { force: true });
        }
      }
    } catch {
      return;
    }
    const drop = (session: string): void => {
      rmSync(join(deps.dir, slotFileOf(session)), { force: true });
      rmSync(metaPath(session), { force: true });
    };
    for (const entry of entries.filter((item) => item.stale)) drop(entry.session);
    entries = entries.filter((item) => !item.stale).sort((a, b) => b.savedAt - a.savedAt);
    let total = 0;
    entries.forEach((entry, index) => {
      total += entry.bytes;
      if (index >= MAX_SLOT_FILES || total > MAX_SLOT_BYTES) drop(entry.session);
    });
  }

  return {
    /**
     * Запрос разговора `session` вот-вот уйдёт серверу. Кеш другого разговора в слоте —
     * сохранить (если стоит того) и поднять кеш этого из файла, а нет файла — стереть слот.
     * Спящий сервер без файла не будится: его слот и так пуст, а запрос разбудит сам.
     */
    switchTo(session: string): Promise<SwitchResult> {
      // Начало запроса — тоже работа: простой считается и от него. Иначе запись по простою,
      // вставшая в очередь за этой сменой, видела бы простой с прошлого хода (замер 15.10:
      // после подъёма из файла тот же кеш тут же писался обратно, 1,6 с впустую).
      lastDoneAt = now();
      return serial(async () => {
        const shape = deps.shape();
        const pid = deps.pid();
        const { owner, asleep } = await currentHolder();
        if (owner?.session === session) {
          onDisk = false;
          return 'kept';
        }
        if (shape && owner && !onDisk && owner.tokens >= SAVE_MIN_TOKENS) await save(owner, shape);
        onDisk = false;
        const meta = readMeta(session);
        if (shape && pid !== undefined && meta && meta.shape === shape) {
          try {
            const tokens = await deps.client.restoreSlot(slotFileOf(session), SLOT_IO_TIMEOUT_MS);
            holder = { session, pid, tokens };
            log(`slot restored: ${session} ${tokens} tokens`);
            return 'restored';
          } catch (error) {
            log(`slot restore failed: ${String(error)}`);
          }
        }
        holder = pid === undefined ? undefined : { session, pid, tokens: 0 };
        // Чей кеш, неизвестно (замер скорости, запрос без метки, прошлый запуск панели) — тоже
        // чужой префикс: стереть. Пуст слот наверняка только у спящего сервера.
        if (asleep || pid === undefined) return 'fresh';
        try {
          await deps.client.eraseSlot(0);
        } catch {
          // Сервер без каталога слотов или занят: запрос идёт как есть.
        }
        return 'erased';
      });
    },

    /**
     * Запрос без метки разговора (проба контура, замер) вот-вот перепишет слот. Кеш
     * разговора в слоте — на диск (если стоит того), а держатель становится неизвестным:
     * иначе следующий ход того же разговора счёл бы слот своим, а запись по простою
     * положила бы под его именем чужой префикс. Слот не стирается — запрос займёт его сам.
     */
    release(): Promise<void> {
      lastDoneAt = now();
      return serial(async () => {
        const shape = deps.shape();
        const { owner } = await currentHolder();
        if (shape && owner && !onDisk && owner.tokens >= SAVE_MIN_TOKENS) await save(owner, shape);
        holder = undefined;
        onDisk = false;
      });
    },

    /** Сколько токенов промпта у запроса, ушедшего за `switchTo`: столько окажется в кеше. */
    noteTokens(tokens: number): void {
      if (holder) holder.tokens = Math.max(holder.tokens, tokens);
    },

    /** Запрос закончен: отсюда считается простой до сна. */
    done(): void {
      lastDoneAt = now();
    },

    /** Сколько сервер простаивает после последнего ответа; запросов не было — `undefined`. */
    idleMs(): number | undefined {
      return lastDoneAt === undefined ? undefined : now() - lastDoneAt;
    },

    /**
     * Перед сном по простою: кеш слота — на диск, один раз до следующего запроса. Простой
     * сверяется с `minIdleMs` уже в очереди: смена разговора перед записью его обнуляет.
     */
    saveIdle(minIdleMs: number): Promise<boolean> {
      return serial(async () => {
        const shape = deps.shape();
        const idle = lastDoneAt === undefined ? undefined : now() - lastDoneAt;
        if (idle === undefined || idle < minIdleMs) return false;
        const { owner } = await currentHolder();
        if (!shape || !owner || onDisk || owner.tokens < SAVE_MIN_TOKENS) return false;
        onDisk = await save(owner, shape);
        return onDisk;
      });
    },
  };
}

export type SlotStore = ReturnType<typeof createSlotStore>;
