import { createHash } from 'node:crypto';
import { basename, join } from 'node:path';
import type { Dialect, RouteResource } from '@agentdeck/contracts/core/routes';
import { hasValue, type Fact } from '../../../platform/os-kind.ts';
import type { ProcessIdentity } from '../../../platform/process-table.ts';
import { writeFileAtomic } from '../../../platform/safe-io/atomic-write.ts';
import {
  createExclusive,
  ensureDir,
  listDir,
  pathExists,
  readBytesSync,
} from '../../../platform/safe-io/files.ts';
import { removeVerified } from '../../../platform/safe-io/remove.ts';

/**
 * Что `local:own` держит на диске, чтобы перезапущенное ядро продолжило с того же места
 * (11 R:PR-04, P10): запись аренды в её каталоге (сервер — личность pid + старт, адрес, метка;
 * база памяти карты до загрузки) и место каждого ждущего слот. Источник правды о мире — процессы:
 * запись лишь говорит, ЧЬЮ личность сверять; чужой процесс с тем же pid личность не пройдёт.
 */

export const LEASE_STATE_FILE = 'lease.json';
const WAITING_DIR = '.slot-waiting';

export interface OwnLeaseState {
  v: 1;
  leaseId: string;
  routeId: string;
  model: string;
  dialect: Dialect;
  slotKey: string;
  /** Ресурсы аренды, как их получил журнал (rid — те же). */
  resources: RouteResource[];
  /** База занятой памяти карты до загрузки (решение fit); нет — сверка памяти невозможна. */
  baselineUsedBytes?: number;
  /** Та же база по каждой карте (id → занятое): сирота на одной карте не прячется за другой. */
  baselineDevices?: Record<string, number>;
  /** Нет — сервер ещё не поднимался: держать нечего, слот свободен. */
  server?: { identity: ProcessIdentity; origin: string; port: number; marker: string };
  /**
   * Неудачный запуск, чьё дерево не доказано снятым (F-64): метка (rid), остаток, корень —
   * личность хранителя или только номер. Перезапущенное ядро держит слот, пока снятие не докажет.
   */
  startLeft?: { rid: string; text: string; root: ProcessIdentity | number };
  /**
   * Ядро, чья это аренда (F-88): пишет выдавшее ядро, перехватившее у мёртвого — себя. Живое
   * чужое ядро свою аренду не отдаёт: её сервер другое ядро не принимает, не освобождает и не
   * останавливает. Нет — запись прежнего вида: чья, неизвестно.
   */
  owner?: WaitOwner;
}

export function writeLeaseState(workDir: string, state: OwnLeaseState): void {
  writeFileAtomic(join(workDir, LEASE_STATE_FILE), JSON.stringify(state), { mode: 0o600 });
}

export function readLeaseState(workDir: string): OwnLeaseState | undefined {
  const bytes = readBytesSync(join(workDir, LEASE_STATE_FILE));
  if (!hasValue(bytes)) return undefined;
  try {
    const state = JSON.parse(bytes.value.toString('utf8')) as OwnLeaseState;
    if (state.v !== 1 || typeof state.leaseId !== 'string' || !Array.isArray(state.resources))
      return undefined;
    // Негодный владелец — не владелец: судится как запись прежнего вида, не как чужое ядро.
    const owner = parseOwner(state.owner);
    if (owner) state.owner = owner;
    else delete state.owner;
    return state;
  } catch {
    return undefined;
  }
}

/** Каталоги аренд под корнем (без служебных, с точки). */
export function leaseDirs(workRoot: string): string[] {
  const names = listDir(workRoot);
  return hasValue(names)
    ? names.value.filter((name) => !name.startsWith('.')).map((name) => join(workRoot, name))
    : [];
}

/** Ссылка ресурса `model-server`: `pid P start S <origin>`. */
export function serverRef(identity: ProcessIdentity, origin: string): string {
  return `pid ${identity.pid} start ${identity.start} ${origin}`;
}

const waitBase = (workRoot: string, slotKey: string, taskId: string): string =>
  join(workRoot, WAITING_DIR, Buffer.from(`${slotKey}\n${taskId}`).toString('base64url'));
const waitPath = (workRoot: string, slotKey: string, taskId: string): string =>
  `${waitBase(workRoot, slotKey, taskId)}.json`;
/** Первая смерть владельца места — рядом с местом (`readWaits` её не примет: нет слота и задачи). */
const deadPath = (workRoot: string, slotKey: string, taskId: string): string =>
  `${waitBase(workRoot, slotKey, taskId)}.dead`;
/**
 * Точка человека о месте, сказанная ждущей задаче (F-88), — рядом с местом, запись на задачу:
 * имя — хэш её id (длина имени не растёт с id), владелец места — внутри записи.
 */
const POINT_TAG = '.point-';
const pointPath = (workRoot: string, place: DeadPlace, waiterTaskId: string): string =>
  `${waitBase(workRoot, place.slotKey, place.taskId)}${POINT_TAG}${createHash('sha256')
    .update(waiterTaskId)
    .digest('base64url')
    .slice(0, 22)}`;

/** Записи точек о месте уходят с местом и при его новой выдаче (другой владелец). */
function dropPoints(workRoot: string, slotKey: string, taskId: string): void {
  const prefix = `${basename(waitBase(workRoot, slotKey, taskId))}${POINT_TAG}`;
  const names = listDir(join(workRoot, WAITING_DIR));
  if (!hasValue(names)) return;
  for (const name of names.value)
    if (name.startsWith(prefix)) removeVerified(join(workRoot, WAITING_DIR, name));
}

/** Чьё место: ядро по личности (pid + старт) и его загрузка. По личности решается, живо ли оно. */
export interface WaitOwner {
  pid: number;
  start: string;
  bootId: string;
}

/** Место ждущего на диске. `owner` нет — файл без владельца (битый или прежнего вида). */
export interface WaitPlace {
  rank: number;
  slotKey: string;
  taskId: string;
  sessionId?: string;
  owner?: WaitOwner;
}

function parseOwner(value: unknown): WaitOwner | undefined {
  const owner = value as Partial<WaitOwner> | null | undefined;
  return owner &&
    typeof owner.pid === 'number' &&
    typeof owner.start === 'string' &&
    typeof owner.bootId === 'string'
    ? { pid: owner.pid, start: owner.start, bootId: owner.bootId }
    : undefined;
}

/** Тот же владелец места: pid, старт и загрузка ядра; оба не записаны — тоже тот же. */
export const sameOwner = (a: WaitOwner | undefined, b: WaitOwner | undefined): boolean =>
  a === undefined || b === undefined
    ? a === b
    : a.pid === b.pid && a.start === b.start && a.bootId === b.bootId;

function parsePlace(text: string): Partial<WaitPlace> {
  try {
    const raw = JSON.parse(text) as Record<string, unknown>;
    const owner = parseOwner(raw['owner']);
    const place: Partial<WaitPlace> = {};
    if (typeof raw['rank'] === 'number' && Number.isFinite(raw['rank'])) place.rank = raw['rank'];
    if (typeof raw['slotKey'] === 'string') place.slotKey = raw['slotKey'];
    if (typeof raw['taskId'] === 'string') place.taskId = raw['taskId'];
    if (typeof raw['sessionId'] === 'string') place.sessionId = raw['sessionId'];
    if (owner) place.owner = owner;
    return place;
  } catch {
    return {};
  }
}

/**
 * Место ждущего: сохранённое прошлым ядром (место прежнее) или новое (сейчас). Владельцем
 * записывается ЭТО ядро — упадёт и оно, следующее увидит, чьё место и живо ли оно.
 */
export function waitRank(
  workRoot: string,
  place: { slotKey: string; taskId: string; sessionId?: string; owner: WaitOwner },
  now: number,
): number {
  const path = waitPath(workRoot, place.slotKey, place.taskId);
  const bytes = readBytesSync(path);
  const kept = hasValue(bytes) ? parsePlace(bytes.value.toString('utf8')).rank : undefined;
  const rank = kept ?? now;
  ensureDir(join(workRoot, WAITING_DIR));
  writeFileAtomic(path, JSON.stringify({ v: 2, rank, ...place }), { mode: 0o600 });
  // Место теперь у живого ядра: смерть прежнего владельца и точки о нём к месту не относятся.
  removeVerified(deadPath(workRoot, place.slotKey, place.taskId));
  dropPoints(workRoot, place.slotKey, place.taskId);
  return rank;
}

type DeadPlace = { slotKey: string; taskId: string; owner?: WaitOwner };

/** Запись рядом с местом — только если она про ЭТОГО владельца места; иначе её нет. */
function readOwned(
  path: string,
  owner: WaitOwner | undefined,
): Record<string, unknown> | undefined {
  const bytes = readBytesSync(path);
  if (!hasValue(bytes)) return undefined;
  try {
    const raw = JSON.parse(bytes.value.toString('utf8')) as Record<string, unknown>;
    return sameOwner(parseOwner(raw['owner']), owner) ? raw : undefined;
  } catch {
    return undefined;
  }
}

/** Записанная первая смерть владельца — только если она про ЭТОГО владельца места. */
function readDeadAt(path: string, owner: WaitOwner | undefined): number | undefined {
  const at = readOwned(path, owner)?.['at'];
  return typeof at === 'number' && Number.isFinite(at) ? at : undefined;
}

/**
 * Окно повторной выдачи считается от ПЕРВОГО факта смерти владельца места (11 R:PR-04), а не от
 * старта читающего ядра: каждое следующее ядро продолжает тот же счёт. Первое ядро, прочитавшее
 * «мёртв» (или «владелец не записан»), пишет время рядом с местом; запись есть и про того же
 * владельца — она и ответ. Создание исключающее: из двух ядер разом время пишет одно. Запись про
 * прежнего владельца или нечитаемая — заменяется. «Неизвестно» сюда не приходит: это не факт смерти.
 */
export function markWaitDead(workRoot: string, place: DeadPlace, now: number): number {
  const path = deadPath(workRoot, place.slotKey, place.taskId);
  const text = JSON.stringify({ v: 1, at: now, owner: place.owner ?? null });
  if (createExclusive(path, text, 0o600) === 'exists') {
    const kept = readDeadAt(path, place.owner);
    if (kept !== undefined) return kept;
    writeFileAtomic(path, text, { mode: 0o600 });
  }
  return now;
}

/** Владелец прочитался живым: прежний «мёртв» опровергнут, счёт окна снимается. */
export function clearWaitDead(workRoot: string, slotKey: string, taskId: string): void {
  removeVerified(deadPath(workRoot, slotKey, taskId));
}

/**
 * Задаче уже сказано точкой человека, что она ждёт за этим местом этого владельца (F-88): одна
 * точка на (место, владелец, ждущая задача) — через перепроверки, перезапуск ядра и обе дороги
 * точки («неизвестно» и живое чужое ядро). Запись про прежнего владельца — не сказано.
 */
export function waitPointTold(workRoot: string, place: DeadPlace, waiterTaskId: string): boolean {
  return readOwned(pointPath(workRoot, place, waiterTaskId), place.owner) !== undefined;
}

/**
 * Точка сказана — запись на диск. Пишется ПОСЛЕ решения в журнал задачи: упавшее между ними ядро
 * повторит точку, а не потеряет её (молча стоящая задача хуже лишней строки).
 */
export function markWaitPoint(workRoot: string, place: DeadPlace, waiterTaskId: string): void {
  ensureDir(join(workRoot, WAITING_DIR));
  writeFileAtomic(
    pointPath(workRoot, place, waiterTaskId),
    JSON.stringify({ v: 1, owner: place.owner ?? null }),
    { mode: 0o600 },
  );
}

/** Место как оно лежит сейчас: нет файла — `absent`, нечитаемое или битое — `unknown`. */
export function readWait(workRoot: string, slotKey: string, taskId: string): Fact<WaitPlace> {
  const bytes = readBytesSync(waitPath(workRoot, slotKey, taskId));
  if (!hasValue(bytes)) return bytes;
  const place = parsePlace(bytes.value.toString('utf8'));
  if (place.slotKey !== slotKey || place.taskId !== taskId || place.rank === undefined)
    return { unknown: `wait place ${slotKey}/${taskId} unparsable` };
  return { value: { ...place, rank: place.rank, slotKey, taskId } };
}

/** Место всё ещё за этим владельцем (не выдано заново другому ядру и не снято). */
export function waitOwnedBy(workRoot: string, place: DeadPlace): boolean {
  const bytes = readBytesSync(waitPath(workRoot, place.slotKey, place.taskId));
  return hasValue(bytes) && sameOwner(parsePlace(bytes.value.toString('utf8')).owner, place.owner);
}

/**
 * Места ждущих этого слота на диске; без места (битый ранг) или чужого слота — не здесь. Читаются
 * только файлы мест (`<base64url>.json`): временный файл атомарной записи (`.<имя>.tmp-…`) несёт
 * то же содержимое и иначе встал бы вторым местом без хозяина (F-68). Битый ранг не ставится в
 * голову очереди рангом 0 (F-62): вернувшийся ждущий перепишет место своим рангом.
 */
export function readWaits(workRoot: string, slotKey: string): WaitPlace[] {
  const dir = join(workRoot, WAITING_DIR);
  const names = listDir(dir);
  if (!hasValue(names)) return [];
  const out: WaitPlace[] = [];
  for (const name of names.value) {
    if (!/^[A-Za-z0-9_-]+\.json$/.test(name)) continue;
    const bytes = readBytesSync(join(dir, name));
    if (!hasValue(bytes)) continue;
    const place = parsePlace(bytes.value.toString('utf8'));
    if (place.slotKey !== slotKey || place.taskId === undefined || place.rank === undefined)
      continue;
    out.push({ ...place, rank: place.rank, slotKey, taskId: place.taskId });
  }
  return out;
}

/** Ожидание кончилось (слот выдан или ждущий снят) — место больше не держится. */
export function dropWait(workRoot: string, slotKey: string, taskId: string): void {
  removeVerified(waitPath(workRoot, slotKey, taskId));
  removeVerified(deadPath(workRoot, slotKey, taskId));
  dropPoints(workRoot, slotKey, taskId);
}

const LEASE_TAG = 'lease:';

/**
 * Точки об аренде живого (или непрояснённого) чужого ядра (F-88) — те же записи, что о месте
 * ждущего: одна на (аренда, владелец, ждущая задача); ключ места — `lease:<id>`.
 */
export const leasePlace = (slotKey: string, leaseId: string, owner?: WaitOwner): DeadPlace => ({
  slotKey,
  taskId: `${LEASE_TAG}${leaseId}`,
  ...(owner ? { owner } : {}),
});

/** Чужая аренда ушла (каталога нет) или принята этим ядром — точки о ней больше не нужны. */
export function dropLeasePoints(workRoot: string, slotKey: string, leaseId: string): void {
  dropPoints(workRoot, slotKey, `${LEASE_TAG}${leaseId}`);
}

/** Точки об арендах, чьих каталогов уже нет (ядро упало, не убрав их), — при возврате состояния. */
export function sweepLeasePoints(workRoot: string): void {
  const dir = join(workRoot, WAITING_DIR);
  const names = listDir(dir);
  if (!hasValue(names)) return;
  for (const name of names.value) {
    const at = name.indexOf(POINT_TAG);
    if (name.startsWith('.') || at <= 0) continue;
    const taskId = Buffer.from(name.slice(0, at), 'base64url').toString('utf8').split('\n')[1];
    const leaseId = taskId?.startsWith(LEASE_TAG) ? taskId.slice(LEASE_TAG.length) : '';
    if (!/^[A-Za-z0-9_-]+$/.test(leaseId)) continue;
    if (!pathExists(join(workRoot, leaseId))) removeVerified(join(dir, name));
  }
}
