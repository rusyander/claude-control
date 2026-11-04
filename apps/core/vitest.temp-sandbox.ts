import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';

import { cleanLiveParent } from './src/platform/__fixtures__/clean-base.ts';
import { reapCoreProcessesUnder } from './src/platform/__fixtures__/reap-home.ts';

/**
 * Свой temp и свой дом ядра на прогон набора. Интеграционный тест ядра никогда не пишет в
 * настоящий `~/.agentdeck/core` (спецификация 00, R:S3-18): дом ядра указывает внутрь каталога
 * прогона, и каталог уходит целиком в конце. GIT_CEILING_DIRECTORIES — чтобы одноразовый
 * репозиторий теста не стал частью репозитория панели (тот же урок, что у сервера, 07.10).
 * AGENTDECK_LIVE_BASE — база живых стендов там, где над ней нет файлов инструкций человека
 * (`clean-base.ts`): temp Windows лежит в профиле, CLI в слое `on` читал бы его `~/.claude`.
 */
const VARS = [
  'TEMP',
  'TMP',
  'TMPDIR',
  'GIT_CEILING_DIRECTORIES',
  'AGENTDECK_CORE_HOME',
  'AGENTDECK_LIVE_BASE',
] as const;
const saved = new Map<string, string | undefined>();
let sandbox: string | undefined;
let liveSandbox: string | undefined;

const OWNER_FILE = 'owner.pid';
/**
 * Метка «каталог завёл прогон, который снимает за собой процессы ядра» (проход 6, 03.11). Хосты под
 * каталогом БЕЗ метки (прогоны до этой правки) уборка не снимает: их остатки — решение человека.
 */
const REAP_MARK = 'reap-owned';
// Каталог без файла владельца (до этой правки) снимается, только когда точно не идёт прогон.
const LEGACY_AGE_MS = 6 * 60 * 60 * 1000;

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM — процесс есть, просто чужой.
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
};

/**
 * Общая база живых стендов (`%ProgramData%\agentdeck-live`) переживает прогоны: убитый прогон
 * (таймаут, прерванный агент) не доходит до `teardown`, а на Windows занятый CLI-файл роняет
 * `rmSync`. Без уборки там копились десятки `vl-*` (31.10: ~70 каталогов, в одном 1720 файлов).
 * Снимается только `vl-*`, чей владелец мёртв; каталог живого прогона не трогается. Тем же
 * правилом — `vc-*` во временной папке (`prefix`, `legacy: false`): каталог без файла владельца там
 * может оказаться чужим, и снимается только размеченный прогоном.
 * Размеченный `REAP_MARK` каталог перед сносом отдаёт процессы ядра, записанные под ним (`reap`).
 */
export async function sweepStaleLive(
  parent: string,
  now = Date.now(),
  {
    prefix = 'vl-',
    legacy = true,
    reap = reapCoreProcessesUnder,
  }: { prefix?: string; legacy?: boolean; reap?: (dir: string) => Promise<unknown> } = {},
): Promise<string[]> {
  const removed: string[] = [];
  for (const name of readdirSync(parent)) {
    if (!name.startsWith(prefix)) continue;
    const dir = join(parent, name);
    let stale: boolean;
    try {
      const pid = Number(readFileSync(join(dir, OWNER_FILE), 'utf8').trim());
      stale = !Number.isInteger(pid) || pid <= 0 || !alive(pid);
    } catch {
      if (!legacy) continue;
      try {
        stale = now - statSync(dir).mtimeMs > LEGACY_AGE_MS;
      } catch {
        continue;
      }
    }
    if (!stale) continue;
    // Убитый прогон до `teardown` не дошёл: его отвязанные хосты держат каталог — снять до сноса.
    const marked = existsSync(join(dir, REAP_MARK));
    if (marked) await reap(dir).catch(() => undefined);
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
      removed.push(name);
    } catch {
      // Занят ещё живым потомком — снимет следующий прогон; размеченному возвращаются метки.
      if (marked) reclaim(dir);
    }
  }
  return removed;
}

/** Каталог прогона: владелец (номер процесса набора) и метка снятия. */
function claim(dir: string): void {
  writeFileSync(join(dir, OWNER_FILE), String(process.pid));
  writeFileSync(join(dir, REAP_MARK), '');
}

/**
 * Снос, упавший на занятом файле, успевает удалить `owner.pid` и метку раньше, чем упасть: без них
 * следующий прогон каталог уже не снимал, и хост под ним жил (`vc-qsdUjV`, 03.11). Метки
 * возвращаются; владелец — этот процесс, к следующему прогону он мёртв.
 */
function reclaim(dir: string): void {
  try {
    if (existsSync(dir)) claim(dir);
  } catch {
    // Каталог ушёл или недоступен — следующему прогону снимать нечего или нельзя.
  }
}

export async function setup(): Promise<void> {
  // Прежние `vc-*` убитых прогонов — тем же правилом, что `vl-*` (только размеченные снимаются).
  await sweepStaleLive(tmpdir(), Date.now(), { prefix: 'vc-', legacy: false }).catch(
    () => undefined,
  );
  sandbox = mkdtempSync(join(tmpdir(), 'vc-'));
  claim(sandbox);
  const real = realpathSync.native(sandbox);
  const coreHome = join(real, 'core-home');
  mkdirSync(coreHome);
  const liveParent = cleanLiveParent();
  // Нет чистой базы — переменная пуста, и живой стенд откажет сам (`liveBase`), не уйдя в профиль.
  if (liveParent !== undefined) await sweepStaleLive(liveParent);
  liveSandbox = liveParent === undefined ? undefined : mkdtempSync(join(liveParent, 'vl-'));
  if (liveSandbox !== undefined) claim(liveSandbox);
  const liveReal = liveSandbox === undefined ? undefined : realpathSync.native(liveSandbox);
  for (const name of VARS) {
    saved.set(name, process.env[name]);
    if (name === 'GIT_CEILING_DIRECTORIES')
      process.env[name] = liveReal === undefined ? real : `${real}${delimiter}${liveReal}`;
    else if (name === 'AGENTDECK_CORE_HOME') process.env[name] = coreHome;
    else if (name === 'AGENTDECK_LIVE_BASE') {
      if (liveReal === undefined) delete process.env[name];
      else process.env[name] = liveReal;
    } else process.env[name] = sandbox;
  }
}

export async function teardown(): Promise<void> {
  for (const name of VARS) {
    const value = saved.get(name);
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  // Хосты сессий и звеньев отвязаны (переживают ядро по замыслу) — сносить каталог можно только
  // после них: живой хост держал каталог, и прогон оставлял его вместе с процессом (02–03.11).
  for (const dir of [sandbox, liveSandbox])
    if (dir) await reapCoreProcessesUnder(dir).catch(() => undefined);
  for (const dir of [sandbox, liveSandbox])
    if (dir)
      try {
        rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
      } catch {
        // Занятый файл не роняет прогон: каталог с мёртвым владельцем снимет следующий `setup`.
        reclaim(dir);
      }
}
