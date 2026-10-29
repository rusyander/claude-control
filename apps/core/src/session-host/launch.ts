import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { parse } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeFileAtomic } from '../platform/safe-io/atomic-write.ts';
import { channelPath } from '../platform/control-channel.ts';
import {
  helperEnv,
  launchDetached,
  type DetachedOutcome,
  type DetachedSpec,
} from '../platform/detached-launch.ts';
import {
  currentOs,
  hasValue,
  reasonOf,
  sleep,
  userRuntimeDir,
  type OsKind,
} from '../platform/os-kind.ts';
import { isAbsolutePath, joinPath } from '../platform/paths.ts';
import { createLivenessProbe, identityOfPid } from '../platform/process-identity.ts';
import { stopTree } from '../platform/tree-stop.ts';
import { TREE_MARKER } from './host.ts';
import {
  sessionFile,
  type ExitRecord,
  type HostRecord,
  type HostSpec,
  type Identity,
} from './protocol.ts';

/**
 * Запуск сессии через хост (03 §Launcher «always through the launcher + session host»).
 * Ядро пишет `token` и `spec.json` (0600), поднимает хост отвязанным и ждёт `host.json`.
 * Окружение CLI идёт ТОЛЬКО файлом описания, который хост удаляет после чтения; сам хост
 * получает системное окружение (`helperEnv`) — ключ маршрута (keyRef, разрешённый
 * запускающим) не попадает ни в argv хоста, ни в его окружение, ни в файлы сессии (P112).
 */

export const HOST_MAIN = fileURLToPath(new URL('./main.ts', import.meta.url));

export interface SessionLaunchSpec {
  /** Каталог сессии в доме ядра (создаётся). */
  dir: string;
  sessionId: string;
  command: string;
  args: string[];
  cwd: string;
  /** Окружение CLI целиком (пин задачи + сессия + ядро + привязка маршрута). */
  env: Record<string, string>;
  extraDirs?: string[];
  /**
   * Windows: хост вне задания ядра (WMI). По умолчанию — да (core-s2 F-56): ядро под сторожем
   * или терминалом в задании без разрешения выхода иначе уносит хост с CLI при своём закрытии.
   * Не задано и WMI закрыт политикой — обычный отвязанный запуск; задано явно — отказ.
   */
  breakaway?: boolean;
  readyTimeoutMs?: number;
}

export type SessionLaunch =
  | { ok: true; host: Identity; child: Identity; channel: string }
  | { ok: false; reason: string; refused?: boolean };

/** Файл есть, но не читается/не разбирается — `garbage`; нет файла — `undefined`. */
function readJson<T>(file: string): T | 'garbage' | undefined {
  if (!existsSync(file)) return undefined;
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as T;
  } catch {
    return 'garbage';
  }
}

export interface SessionLaunchDeps {
  /** Запуск процесса хоста; тест оборачивает настоящий, чтобы увидеть отданное ОС окружение. */
  launch?: (spec: DetachedSpec) => Promise<DetachedOutcome>;
}

// ---- F-60: личный каталог сокета POSIX ----

/** Предел `sun_path` с запасом (104 байта macOS, 108 Linux) — как в `control-channel.ts`. */
const SUN_PATH_MAX = 100;

/**
 * Каталог `dir` — личный каталог этого пользователя: создаётся 0700; существующий должен быть
 * каталогом (не ссылкой), принадлежать `uid`; открытый группе/миру закрывается до 0700.
 * `null` — годен, иначе причина.
 */
export function preparePrivateDir(dir: string, uid: number): string | null {
  try {
    mkdirSync(dir, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') return reasonOf(error);
  }
  try {
    const stat = lstatSync(dir);
    if (stat.isSymbolicLink()) return `${dir} is a symlink`;
    if (!stat.isDirectory()) return `${dir} is not a directory`;
    if (stat.uid !== uid) return `${dir} owned by uid ${stat.uid}`;
    if ((stat.mode & 0o077) !== 0) {
      chmodSync(dir, 0o700);
      if ((lstatSync(dir).mode & 0o077) !== 0) return `${dir} stays open to others`;
    }
    return null;
  } catch (error) {
    return reasonOf(error);
  }
}

export interface ChannelDirOptions {
  os?: OsKind;
  env?: NodeJS.ProcessEnv;
  temp?: string;
  uid?: number;
  prepare?: (dir: string, uid: number) => string | null;
}

/**
 * Где хост POSIX слушает (core-s2 F-60): НЕ общий `/tmp` с предсказуемым именем (там чужой
 * пользователь занимает имя заранее), а личный каталог 0700 — `$XDG_RUNTIME_DIR/agentdeck`,
 * иначе `<temp>/agentdeck-<uid>`, иначе `/tmp/agentdeck-<uid>`. Кандидат, в котором путь сокета
 * не укладывается в `sun_path`, пропускается. Ни один не годен — причина, общего `/tmp` нет.
 */
export function privateChannelDir(
  opts: ChannelDirOptions = {},
): { value: string } | { unknown: string } {
  const env = opts.env ?? process.env;
  const uid = opts.uid ?? process.getuid?.();
  if (uid === undefined) return { unknown: 'no uid on this platform' };
  const prepare = opts.prepare ?? preparePrivateDir;
  const temp = opts.temp ?? tmpdir();
  // Путь сокета POSIX: склейка по правилам POSIX, где бы ни проверялся (Windows — тесты).
  const posix: OsKind = opts.os === 'darwin' ? 'darwin' : 'linux';
  const xdg = userRuntimeDir(env);
  const candidates = [
    ...(xdg && isAbsolutePath(xdg, posix) ? [joinPath(posix, xdg, 'agentdeck')] : []),
    joinPath(posix, temp, `agentdeck-${uid}`),
    `/tmp/agentdeck-${uid}`,
  ];
  // Самое длинное имя сокета (`ad-sh-` + 40 знаков id + `.sock`) должно уложиться.
  const longest = `ad-sh-${'x'.repeat(40)}.sock`;
  const tried: string[] = [];
  for (const dir of new Set(candidates)) {
    if (Buffer.byteLength(joinPath(posix, dir, longest)) > SUN_PATH_MAX) {
      tried.push(`${dir}: too long for sun_path`);
      continue;
    }
    const refused = prepare(dir, uid);
    if (refused === null) return { value: dir };
    tried.push(refused);
  }
  return { unknown: `no private socket dir: ${tried.join('; ')}` };
}

function channelFor(sessionId: string, os: OsKind): { value: string } | { unknown: string } {
  if (os === 'win32') return { value: channelPath(sessionId, os) };
  const dir = privateChannelDir({ os });
  if (!('value' in dir)) return dir;
  return { value: channelPath(sessionId, os, dir.value) };
}

// ---- F-100: каталог сессии, оставшийся от прошлого хоста ----

/**
 * Прошлый хост в этом каталоге: живой (или не проверить) — каталог занят, его ключ и записи не
 * трогаем; мёртвый — его `host.json`/`exit.json`/`host.err` убираются, иначе опрос ниже принял
 * бы чужой исход (отказ, сбой, другой pid) за исход нового хоста (core-s2 F-100).
 */
async function clearStaleHost(dir: string): Promise<string | null> {
  const prior = readJson<HostRecord>(sessionFile(dir, 'host'));
  if (prior && prior !== 'garbage' && prior.host) {
    const live = await createLivenessProbe(undefined, 0).isAlive(prior.host);
    if (live !== 'dead') return `session dir has a live host (pid ${prior.host.pid}, ${live})`;
  }
  for (const name of ['host', 'exit', 'hostErr'] as const)
    rmSync(sessionFile(dir, name), { force: true });
  return null;
}

// ---- F-99: хост, который не доложил о готовности ----

/** Снять запущенный хост по личности и дерево CLI по метке; ошибки остановки не маскируют исход. */
async function abandonHost(host: Identity | undefined, sessionId: string): Promise<void> {
  if (!host) return;
  await stopTree(host, {
    graceMs: 1_000,
    marker: { name: TREE_MARKER, value: sessionId },
  }).catch(() => undefined);
}

export async function launchSession(
  spec: SessionLaunchSpec,
  deps: SessionLaunchDeps = {},
): Promise<SessionLaunch> {
  const launch = deps.launch ?? launchDetached;
  const os = currentOs();
  mkdirSync(spec.dir, { recursive: true, mode: 0o700 });
  const busy = await clearStaleHost(spec.dir);
  if (busy) return { ok: false, reason: busy, refused: true };
  const channel = channelFor(spec.sessionId, os);
  if (!('value' in channel)) return { ok: false, reason: channel.unknown, refused: true };
  writeFileAtomic(sessionFile(spec.dir, 'token'), randomBytes(24).toString('hex'), { mode: 0o600 });
  const hostSpec: HostSpec = {
    v: 1,
    sessionId: spec.sessionId,
    command: spec.command,
    args: spec.args,
    cwd: spec.cwd,
    env: spec.env,
    ...(spec.extraDirs ? { extraDirs: spec.extraDirs } : {}),
    channel: channel.value,
  };
  writeFileAtomic(sessionFile(spec.dir, 'spec'), JSON.stringify(hostSpec), { mode: 0o600 });

  const hostLaunch: DetachedSpec = {
    file: process.execPath,
    args: ['--experimental-strip-types', '--no-warnings', HOST_MAIN, spec.dir],
    // Корень тома, как у демона: рабочая папка процесса держит каталог на Windows, а conhost
    // хоста наследует её и уходит на миллисекунды ПОЗЖЕ хоста — каталог сессии под нагрузкой
    // ловил EBUSY уже после «хост ушёл» (замер: conhost жив в миг отказа, через 17 мс свободно).
    // Каталог сессии хосту приходит аргументом, CLI — своей `spec.cwd`.
    cwd: parse(spec.dir).root,
    env: helperEnv(),
  };
  const breakaway = spec.breakaway ?? os === 'win32';
  let started = await launch(breakaway ? { ...hostLaunch, breakaway: true } : hostLaunch);
  // WMI закрыт политикой, а вырыв из задания не требовали явно — хост в задании лучше, чем
  // никакого: ядро вне задания (обычный случай) его и так не уносит.
  if (!started.ok && breakaway && spec.breakaway === undefined) started = await launch(hostLaunch);
  if (!started.ok) return { ok: false, reason: `host did not start: ${started.reason}` };
  // Личность хоста — сразу: по ней хост снимается, если не доложит о готовности (F-99).
  const hostFact = await identityOfPid(started.pid);
  const hostId = hasValue(hostFact) ? hostFact.value : undefined;
  const fail = async (reason: string): Promise<SessionLaunch> => {
    await abandonHost(hostId, spec.sessionId);
    return { ok: false, reason };
  };

  const deadline = Date.now() + (spec.readyTimeoutMs ?? 30_000);
  for (;;) {
    const record = readJson<HostRecord>(sessionFile(spec.dir, 'host'));
    const exit = readJson<ExitRecord>(sessionFile(spec.dir, 'exit'));
    // Записи пишутся атомарно; нечитаемая — недописанная или ещё занятая ОС: ждём следующую.
    const settled = record !== undefined && record !== 'garbage' && exit !== 'garbage';
    if (settled) {
      if (exit?.refused) return { ok: false, reason: exit.refused, refused: true };
      if (record.host.pid !== started.pid)
        return fail(`host.json names pid ${record.host.pid}, started ${started.pid}`);
      if (!record.child) return fail('host record without a child');
      return { ok: true, host: record.host, child: record.child, channel: record.channel };
    }
    const err = sessionFile(spec.dir, 'hostErr');
    // Упавший хост мог не выйти сам (канал ещё держит процесс) — снимается так же.
    if (existsSync(err)) return fail(`host failed: ${readFileSync(err, 'utf8').trim()}`);
    if (Date.now() > deadline) return fail('host not ready in time');
    await sleep(50);
  }
}
