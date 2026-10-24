import { subscribe } from 'node:diagnostics_channel';

/**
 * Реестр процессов, запущенных этим сервером (RF-BGCD-09): номер, момент
 * запуска и — когда он вышел — момент выхода. Добор процессов копии после паузы
 * (`process-tree/path-sweep.ts`) снимает только записанное здесь и потомков
 * записанного; незаписанное не трогает, сколько бы ему ни было лет. Прежде
 * сироту без метки решал возраст — «моложе сервера — наш», — и процесс
 * человека, поднятый в копии группы после старта панели, снимался как сирота.
 *
 * Точка записи — одна на все запуски: канал `child_process` из
 * `node:diagnostics_channel`, который Node публикует при создании любого
 * `ChildProcess` (`spawn`, `execFile`, `exec`, `fork`) — и CLI чата
 * (`ChatRunner`, `cli-spawn.ts`), и посредник, и dev-сервер, и любой будущий
 * запуск. Перечислять места запуска руками значило бы пропустить следующее.
 * Синхронные `spawnSync`/`execFileSync` в канал не попадают: их процесс
 * кончается до возврата вызова.
 *
 * Запись живёт и после выхода процесса: сироты переживают родителя, и на
 * Windows их `ppid` так и указывает на его номер. Время создания ребёнка
 * сверяется с жизнью записи (между запуском и выходом), так что номер,
 * отданный потом чужому, чужих детей своими не делает.
 */

export interface SpawnRecord {
  pid: number;
  /** Момент, когда процесс точно жил (мс Unix): событие `spawn`, сразу после создания. */
  spawnedAt: number;
  /** Момент, когда сервер узнал о выходе (мс Unix); нет — процесс жив или выход не пришёл. */
  exitedAt?: number;
}

interface Spawned {
  pid?: number | undefined;
  once?: (event: string, listener: () => void) => unknown;
}

/** Потолок памяти: старейшие вышедшие уходят первыми. Живые не вытесняются никогда. */
const LIMIT = 4096;

/**
 * Записи и подписка — на `globalThis`: модуль, загруженный дважды (тестовый
 * прогон, разные пути импорта), обязан видеть те же записи, что и подписчик.
 */
const INSTALLED = Symbol.for('agentdeck.spawn-registry');
const RECORDS = Symbol.for('agentdeck.spawn-registry.records');
const scope = globalThis as { [INSTALLED]?: true; [RECORDS]?: SpawnRecord[] };
const records: SpawnRecord[] = (scope[RECORDS] ??= []);

function trim(): void {
  if (records.length <= LIMIT) return;
  for (let at = 0; at < records.length && records.length > LIMIT;) {
    if (records[at]?.exitedAt !== undefined) records.splice(at, 1);
    else at += 1;
  }
}

/** Записать процесс по его `spawn`; без номера (запуск упал) — ничего. */
export function recordSpawn(child: Spawned, now: () => number = Date.now): void {
  const take = (): void => {
    const pid = child.pid;
    if (typeof pid !== 'number' || pid <= 0) return;
    const record: SpawnRecord = { pid, spawnedAt: now() };
    records.push(record);
    trim();
    child.once?.('exit', () => {
      record.exitedAt = now();
    });
  };
  // Канал публикует процесс в конструкторе, до запуска: номера ещё нет.
  if (typeof child.pid === 'number') take();
  else child.once?.('spawn', take);
}

/** Снимок записей — для добора; копия, чтобы плану не мешали новые запуски. */
export function spawnRecords(): SpawnRecord[] {
  return records.map((record) => ({ ...record }));
}

/** Один подписчик на процесс сервера, сколько бы раз модуль ни загрузили. */
export function installSpawnRegistry(): void {
  if (scope[INSTALLED]) return;
  scope[INSTALLED] = true;
  subscribe('child_process', (message) => {
    try {
      recordSpawn((message as { process?: Spawned }).process ?? {});
    } catch {
      // Реестр — страховка добора, он не имеет права ронять запуск.
    }
  });
}

installSpawnRegistry();
