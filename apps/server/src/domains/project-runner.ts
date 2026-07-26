import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createConnection } from 'node:net';
import { existsSync, statSync, readFileSync, readdirSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import type {
  PortHoldersInfo,
  ProjectRunnerInfo,
  ProjectRunnerStatus,
  ProjectRunnerTarget,
  ProjectRunnerView,
  ProjectWorkspaceSource,
} from '@claude-control/contracts';
import { shellArgs, quoteForShell } from '../lib/cli-args.ts';

/**
 * Запуск и остановка dev-серверов проекта прямо из панели.
 *
 * Запускается не «проект», а ЦЕЛЬ — каталог с собственным package.json: сам
 * корень или пакет монорепозитория. Целей у одной вкладки может работать
 * несколько сразу, ключ реестра — абсолютный путь каталога запуска.
 *
 * ПОРТ ПАНЕЛЬ НЕ НАЗНАЧАЕТ. Раньше она выбирала свободный порт и передавала его
 * в `PORT`; так работают только create-react-app и Next, а Vite, Angular и любой
 * сервер с портом в конфиге эту переменную игнорируют — панель ждала адрес, по
 * которому никто не слушает. Теперь порт ЧИТАЕТСЯ из вывода dev-сервера: строку
 * вида «Local: http://localhost:5173» печатают все. Закрепить порт можно вручную —
 * тогда `PORT` передаётся и ожидание идёт по нему.
 *
 * Чистые части (разбор вывода, поиск целей, выбор команды и пакетного менеджера)
 * вынесены отдельными функциями — их проверяют тесты без настоящего dev-сервера.
 * Открытие браузера инъектируется, чтобы тест его не звал.
 */

const isWindows = process.platform === 'win32';

/** Сколько ждём адреса, прежде чем признать, что сервер его не назвал. */
const READY_TIMEOUT_MS = 30_000;
/** Шаг опроса порта при ожидании готовности. */
const READY_POLL_MS = 300;
/**
 * Локальные адреса, по которым проверяем порт: IPv4 и IPv6. Проверять надо оба —
 * `localhost` разрешается по-разному, и сервер может слушать только один из них.
 */
const PROBE_HOSTS = ['127.0.0.1', '::1'];
/** Сколько целей отдаём максимум: в большой монорепе список иначе бесполезен. */
const MAX_TARGETS = 60;
/** Глубина, на которую разворачивается `**` в шаблоне воркспейсов. */
const GLOB_DEPTH = 3;
/** Хвост вывода процесса, который держим для показа и разбора адреса. */
const OUTPUT_TAIL = 8_000;

/** Пакетный менеджер проекта — по lock-файлу. */
export type PackageManager = 'pnpm' | 'yarn' | 'npm';

/** Что и как запускать: исполняемый файл, аргументы и человекочитаемая команда. */
export interface LaunchSpec {
  file: string;
  args: string[];
  /** Команда для показа пользователю (`pnpm run dev`). */
  display: string;
}

/** Ошибка запуска с кодом — маршрут превращает её в 400 с внятным текстом. */
export class RunnerError extends Error {
  code: 'bad-path' | 'no-script' | 'port-busy';
  /** Порт, из-за которого отказ, — панель предложит его освободить. */
  port?: number;
  constructor(code: 'bad-path' | 'no-script' | 'port-busy', message: string, port?: number) {
    super(message);
    this.code = code;
    this.port = port;
    this.name = 'RunnerError';
  }
}

/**
 * Пакетный менеджер проекта.
 *
 * Сначала поле `packageManager` (`"pnpm@9.1.0"`) — это corepack, то есть прямое
 * указание автора проекта, и оно точнее любой догадки. Дальше lock-файл. В
 * монорепе и то и другое лежит в КОРНЕ, а запускаем мы из подпапки, поэтому от
 * каталога цели поднимаемся вверх до `stopAt` включительно — иначе у любого
 * пакета монорепы получался бы npm независимо от того, чем проект живёт.
 * Ничего не нашли — npm: он есть везде, где есть Node.
 */
export function detectPackageManager(dir: string, stopAt?: string): PackageManager {
  const top = resolve(stopAt ?? dir);
  let current = resolve(dir);
  for (;;) {
    const declared = readPackageJson(current)?.packageManager;
    if (typeof declared === 'string') {
      const name = declared.split('@')[0]?.trim();
      if (name === 'pnpm' || name === 'yarn' || name === 'npm') return name;
    }
    // pnpm-workspace.yaml бывает в git, а lock-файл — далеко не всегда, поэтому
    // он тоже считается признаком: без этого монорепа на pnpm запускалась бы npm.
    if (
      existsSync(join(current, 'pnpm-lock.yaml')) ||
      existsSync(join(current, 'pnpm-workspace.yaml')) ||
      existsSync(join(current, 'pnpm-workspace.yml'))
    ) {
      return 'pnpm';
    }
    if (existsSync(join(current, 'yarn.lock'))) return 'yarn';
    if (existsSync(join(current, 'package-lock.json'))) return 'npm';
    if (current === top) break;
    const up = dirname(current);
    if (up === current) break;
    current = up;
  }
  return 'npm';
}

/** Содержимое package.json каталога; при отсутствии/битом файле — undefined. */
function readPackageJson(dir: string): PackageJsonShape | undefined {
  try {
    return JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as PackageJsonShape;
  } catch {
    return undefined;
  }
}

interface PackageJsonShape {
  name?: string;
  scripts?: Record<string, string>;
  workspaces?: string[] | { packages?: string[] };
  /** Поле corepack: `"pnpm@9.1.0"` — прямое указание, чем запускать. */
  packageManager?: string;
}

/** Скрипт запуска: `dev`, иначе `start`, иначе ничего. */
export function detectRunScript(dir: string): 'dev' | 'start' | undefined {
  const scripts = readPackageJson(dir)?.scripts ?? {};
  if (scripts.dev) return 'dev';
  if (scripts.start) return 'start';
  return undefined;
}

/**
 * Разбор строки-оверрайда на слова с учётом кавычек: `node "my server.js" --port`
 * → ['node', 'my server.js', '--port']. Оверрайд задаёт пользователь для своего
 * проекта, поэтому достаточно простого разбора кавычек, без полного шелла.
 */
export function tokenize(command: string): string[] {
  const tokens: string[] = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(command)) !== null) {
    tokens.push(match[1] ?? match[2] ?? match[3] ?? '');
  }
  return tokens;
}

/**
 * Итоговая команда запуска: оверрайд (если задан) в приоритете, иначе
 * `<pm> run <dev|start>`. Нет ни скрипта, ни оверрайда → RunnerError.
 */
export function resolveRunCommand(
  targetDir: string,
  override?: string,
  projectRoot?: string,
): LaunchSpec {
  const trimmed = override?.trim();
  if (trimmed) {
    const [file, ...args] = tokenize(trimmed);
    if (!file) throw new RunnerError('no-script', 'Команда запуска пуста.');
    return { file, args, display: trimmed };
  }

  const script = detectRunScript(targetDir);
  if (!script) {
    throw new RunnerError(
      'no-script',
      'В package.json нет скрипта dev или start. Задайте команду запуска вручную.',
    );
  }
  const pm = detectPackageManager(targetDir, projectRoot);
  return { file: pm, args: ['run', script], display: `${pm} run ${script}` };
}

/* ── Цели запуска: корень и пакеты монорепозитория ───────────────────── */

/** Каталог существует и это каталог. */
function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** Содержимое каталога; нет доступа — пустой список, а не исключение. */
function safeReaddir(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

/** Служебные и скрытые каталоги в обходе не участвуют. */
function isSkippedDir(name: string): boolean {
  return name.startsWith('.') || name === 'node_modules' || name === 'dist' || name === 'build';
}

/**
 * Развернуть шаблон воркспейса (`apps/*`, `packages/**`) в список подпапок.
 *
 * Полного glob здесь нет намеренно: в шаблонах воркспейсов встречаются ровно
 * `*` и `**`, а тащить зависимость ради двух случаев незачем. `**` разворачивается
 * на ограниченную глубину — иначе обход большой монорепы стоит дороже, чем даёт.
 */
export function expandWorkspacePattern(root: string, pattern: string): string[] {
  const parts = pattern.split('/').filter((part) => part && part !== '.');
  let dirs: string[] = [''];

  for (const part of parts) {
    const next: string[] = [];
    for (const dir of dirs) {
      const abs = join(root, dir);
      if (part === '*' || part === '**') {
        const children = safeReaddir(abs)
          .filter((name) => !isSkippedDir(name))
          .filter((name) => isDirectory(join(abs, name)))
          .map((name) => (dir ? `${dir}/${name}` : name));
        next.push(...children);
        // `**` — это ещё и «на уровень глубже», и так до предела.
        if (part === '**') {
          let frontier = children;
          for (let depth = 1; depth < GLOB_DEPTH && frontier.length > 0; depth += 1) {
            const deeper: string[] = [];
            for (const child of frontier) {
              const childAbs = join(root, child);
              deeper.push(
                ...safeReaddir(childAbs)
                  .filter((name) => !isSkippedDir(name))
                  .filter((name) => isDirectory(join(childAbs, name)))
                  .map((name) => `${child}/${name}`),
              );
            }
            next.push(...deeper);
            frontier = deeper;
          }
        }
      } else if (isDirectory(join(abs, part))) {
        next.push(dir ? `${dir}/${part}` : part);
      }
    }
    dirs = [...new Set(next)];
  }

  return dirs.filter(Boolean);
}

/** Шаблоны воркспейсов проекта и то, откуда они взяты. */
export function workspacePatterns(
  projectDir: string,
): { patterns: string[]; source: ProjectWorkspaceSource } | undefined {
  for (const name of ['pnpm-workspace.yaml', 'pnpm-workspace.yml']) {
    const file = join(projectDir, name);
    if (!existsSync(file)) continue;
    try {
      const doc = parseYaml(readFileSync(file, 'utf8')) as { packages?: unknown };
      const packages = Array.isArray(doc?.packages) ? doc.packages : [];
      const patterns = packages.filter((item): item is string => typeof item === 'string');
      if (patterns.length > 0) return { patterns, source: 'pnpm' };
    } catch {
      // Битый pnpm-workspace.yaml — не повод падать: ниже сработает скан папок.
    }
  }

  const workspaces = readPackageJson(projectDir)?.workspaces;
  const list = Array.isArray(workspaces) ? workspaces : workspaces?.packages;
  if (Array.isArray(list)) {
    const patterns = list.filter((item): item is string => typeof item === 'string');
    if (patterns.length > 0) return { patterns, source: 'npm' };
  }

  // Ни pnpm-workspace, ни workspaces — смотрим в общепринятые места. Это
  // догадка, поэтому источник так и называется, а пользователь видит её в панели.
  const guessed = ['apps', 'packages', 'services'].filter((dir) =>
    isDirectory(join(projectDir, dir)),
  );
  if (guessed.length > 0) return { patterns: guessed.map((dir) => `${dir}/*`), source: 'scan' };

  return undefined;
}

/** Найденная цель до наложения пользовательских настроек. */
export interface RunnerTargetSpec {
  dir: string;
  path: string;
  name: string;
}

/**
 * Что в этом проекте вообще можно запускать: сам корень (всегда первым — даже
 * без скрипта, чтобы было куда вписать команду вручную) и пакеты монорепозитория
 * со скриптом dev/start.
 */
export function listRunnerTargets(projectDir: string): {
  targets: RunnerTargetSpec[];
  source?: ProjectWorkspaceSource;
  skipped: number;
} {
  const root = resolve(projectDir);
  const rootName = readPackageJson(root)?.name ?? basename(root);
  const targets: RunnerTargetSpec[] = [{ dir: '', path: root, name: rootName }];

  const workspaces = workspacePatterns(root);
  if (!workspaces) return { targets, skipped: 0 };

  const negated = workspaces.patterns
    .filter((pattern) => pattern.startsWith('!'))
    .map((pattern) => pattern.slice(1).replace(/\/+$/, ''));
  const seen = new Set<string>();
  let skipped = 0;

  for (const pattern of workspaces.patterns) {
    if (pattern.startsWith('!')) continue;
    for (const dir of expandWorkspacePattern(root, pattern)) {
      if (seen.has(dir) || negated.includes(dir)) continue;
      seen.add(dir);

      const abs = join(root, dir);
      const pkg = readPackageJson(abs);
      // Пакет без скрипта запуска — библиотека: в списке «что запустить» её нет.
      if (!pkg?.scripts?.dev && !pkg?.scripts?.start) continue;

      if (targets.length >= MAX_TARGETS) {
        skipped += 1;
        continue;
      }
      targets.push({ dir, path: abs, name: pkg.name ?? basename(abs) });
    }
  }

  return { targets, source: workspaces.source, skipped };
}

/** Что панель помнит про одну цель. */
export interface TargetMemory {
  command?: string;
  pinnedPort?: number;
  port?: number;
  autostart?: boolean;
}

/**
 * Описание целей запуска для панели: команда, причина отказа и всё, что панель
 * помнит про каждую цель. Одним запросом — поповеру настроек нужен весь список
 * сразу, а не маршрут на цель.
 */
export function describeRunner(
  projectDir: string,
  memoryOf: (targetPath: string) => TargetMemory | undefined = () => undefined,
): ProjectRunnerInfo {
  const root = resolve(projectDir);
  const found = listRunnerTargets(root);

  const targets: ProjectRunnerTarget[] = found.targets.map((target) => {
    const memory = memoryOf(target.path) ?? {};
    const base = {
      dir: target.dir,
      path: target.path,
      name: target.name,
      commandOverride: memory.command,
      pinnedPort: memory.pinnedPort,
      lastPort: memory.port,
      autostart: Boolean(memory.autostart),
    };
    try {
      const spec = resolveRunCommand(target.path, memory.command, root);
      return { ...base, runnable: true, command: spec.display };
    } catch (error) {
      return {
        ...base,
        runnable: false,
        reason: error instanceof Error ? error.message : String(error),
      };
    }
  });

  return { projectPath: root, targets, workspaceSource: found.source, skipped: found.skipped };
}

/* ── Адрес dev-сервера: читаем, а не назначаем ───────────────────────── */

/**
 * Управляющие последовательности цвета — до разбора адреса их снимаем: адрес
 * почти всегда напечатан цветным, и без этого регулярка не совпала бы.
 */
// eslint-disable-next-line no-control-regex -- ESC и есть ровно то, что мы вырезаем
const ANSI = /\u001B\[[0-9;?]*[ -/]*[@-~]/g;

/**
 * Локальный адрес в выводе dev-сервера: `http://localhost:5173`,
 * `http://127.0.0.1:3000/`, `http://[::1]:4200`.
 *
 * Совпадения по внешним адресам (`Network: http://192.168.1.5:5173`) намеренно
 * не ловим: панель ведёт пользователя на localhost, и он должен быть тем же
 * localhost, который она проверяет TCP-пробой.
 */
const LOCAL_URL = /https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1?\]):(\d{2,5})/i;

/** Порт из вывода процесса или undefined, если адреса там ещё нет. */
export function extractServerPort(output: string): number | undefined {
  const match = LOCAL_URL.exec(output.replace(ANSI, ''));
  if (!match) return undefined;
  const port = Number(match[1]);
  return Number.isInteger(port) && port > 0 && port < 65_536 ? port : undefined;
}

/** Одна попытка TCP-подключения к конкретному хосту: слушает он или нет. */
function connectOnce(port: number, host: string): Promise<boolean> {
  return new Promise((resolveProbe) => {
    const socket = createConnection({ port, host });
    const settle = (ok: boolean): void => {
      socket.destroy();
      resolveProbe(ok);
    };
    socket.once('connect', () => settle(true));
    socket.once('error', () => settle(false));
    socket.setTimeout(1000, () => settle(false));
  });
}

/**
 * Слушает ли порт — по обеим семьям адресов сразу.
 *
 * `localhost` на Windows разрешается в `::1`, и dev-сервер сплошь и рядом
 * слушает ТОЛЬКО его (или наоборот, только 127.0.0.1). Проба по одному хосту
 * объявляла бы живой сервер «работает, адрес не определён» — ровно тот случай,
 * когда кнопка «Перейти» не появлялась.
 */
function probeConnect(port: number): Promise<boolean> {
  return new Promise((settle) => {
    let left = PROBE_HOSTS.length;
    let done = false;
    for (const host of PROBE_HOSTS) {
      void connectOnce(port, host).then((ok) => {
        if (done) return;
        // Первый успех решает: ждать вторую семью адресов незачем, а на хосте
        // без IPv6 её попытка может висеть до собственного таймаута.
        if (ok) {
          done = true;
          settle(true);
          return;
        }
        left -= 1;
        if (left === 0) {
          done = true;
          settle(false);
        }
      });
    }
  });
}

/** Слушает ли уже кто-нибудь этот порт. */
export function isPortBusy(port: number): Promise<boolean> {
  return probeConnect(port);
}

/**
 * Порт, который сервер объявил занятым, — из его собственного вывода.
 *
 * Требуем именно «already in use» либо `EADDRINUSE`: Vite при свободном выборе
 * порта печатает «Port 5173 is in use, trying another one...» и спокойно
 * поднимается на следующем — это не отказ и предлагать убийство там нечего.
 */
const PORT_TAKEN = /port\s+(\d{2,5})\s+is\s+already\s+in\s+use/i;
const ADDR_IN_USE = /EADDRINUSE[^\n]{0,80}?:(\d{2,5})\b/i;

export function extractBusyPort(output: string): number | undefined {
  const clean = output.replace(ANSI, '');
  const match = PORT_TAKEN.exec(clean) ?? ADDR_IN_USE.exec(clean);
  if (!match) return undefined;
  const port = Number(match[1]);
  return Number.isInteger(port) && port > 0 && port < 65_536 ? port : undefined;
}

/** Строки вывода команды ОС; пустой массив, если команда недоступна. */
function runLines(file: string, args: string[]): string[] {
  const result = spawnSync(file, args, { encoding: 'utf8', windowsHide: true });
  if (result.error || typeof result.stdout !== 'string') return [];
  return result.stdout.split(/\r?\n/).filter((line) => line.trim().length > 0);
}

/**
 * Имена процессов по списку PID — чтобы пользователь видел, кого ему предлагают
 * убить.
 *
 * ОДИН вызов на весь список, а не по вызову на PID: `tasklist` с фильтром
 * стоит секунды, а `spawnSync` держит цикл событий — сервер панели на это время
 * замирает целиком. Полный список процессов стоит столько же, сколько один
 * отфильтрованный, поэтому берём его разом и раскладываем в карту.
 */
function processNames(pids: number[]): Map<number, string> {
  const names = new Map<number, string>();
  if (pids.length === 0) return names;

  if (isWindows) {
    for (const line of runLines('tasklist', ['/NH', '/FO', 'CSV'])) {
      // CSV: "имя.exe","PID","сессия",...
      const parts = /^"([^"]+)","(\d+)"/.exec(line);
      const pid = Number(parts?.[2]);
      if (parts?.[1] && Number.isInteger(pid)) names.set(pid, parts[1]);
    }
  } else {
    for (const line of runLines('ps', ['-o', 'pid=,comm=', '-p', pids.join(',')])) {
      const parts = /^\s*(\d+)\s+(.+)$/.exec(line);
      const pid = Number(parts?.[1]);
      if (parts?.[2] && Number.isInteger(pid)) names.set(pid, parts[2].trim());
    }
  }
  return names;
}

/**
 * Кто слушает порт — по данным ОС.
 *
 * Windows: `netstat -ano` (единственный способ без сторонних утилит), POSIX:
 * `lsof`. Ни одна из команд не обязана существовать — пустой список значит
 * «не выяснили», а не «порт свободен»; занятость определяет TCP-проба.
 */
export function findPortHolders(port: number): number[] {
  const pids = new Set<number>();
  if (isWindows) {
    // Без `-p tcp`: с этим ключом netstat отдаёт только IPv4, а dev-серверы
    // сплошь и рядом слушают ровно `[::1]` — и порт «не находился».
    for (const line of runLines('netstat', ['-ano'])) {
      if (!/^\s*TCP\b/i.test(line) || !/LISTENING/i.test(line)) continue;
      const parts = line.trim().split(/\s+/);
      const local = parts[1];
      const pid = Number(parts[parts.length - 1]);
      // Хвост локального адреса — именно `:порт`, иначе 8888 поймает и 18888.
      if (!local?.endsWith(`:${port}`) || !Number.isInteger(pid)) continue;
      if (pid > 4) pids.add(pid);
    }
  } else {
    for (const line of runLines('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t'])) {
      const pid = Number(line.trim());
      if (Number.isInteger(pid) && pid > 1) pids.add(pid);
    }
  }
  // Себя не показываем и тем более не убиваем: сервер панели тоже слушает порт.
  pids.delete(process.pid);
  return [...pids];
}

/**
 * Кто держит порт, с именами процессов и пометкой «это наш запуск».
 *
 * Занятость определяет TCP-проба, а не длина списка: `netstat`/`lsof` может не
 * оказаться или не показать чужой процесс из-под другого пользователя — тогда
 * порт занят, а держатели неизвестны. Обратное («список есть, а порт свободен»)
 * тоже бывает: строка могла устареть между двумя вызовами.
 */
export async function describePort(
  port: number,
  isOurs: (pid: number) => boolean,
): Promise<PortHoldersInfo> {
  const pids = findPortHolders(port);
  const names = processNames(pids);
  const holders = pids.map((pid) => ({
    pid,
    name: names.get(pid),
    ours: isOurs(pid),
  }));
  return { port, busy: (await isPortBusy(port)) || holders.length > 0, holders };
}

/**
 * Освободить порт: погасить деревья процессов, которые его слушают.
 *
 * Делается только по явной команде пользователя — панель сама не решает, что
 * чужой процесс лишний. Свой PID из списка уже исключён в `findPortHolders`.
 */
export async function freePort(
  port: number,
  isOurs: (pid: number) => boolean,
): Promise<PortHoldersInfo> {
  const killed: number[] = [];
  for (const pid of findPortHolders(port)) {
    killTree(pid);
    killed.push(pid);
  }
  // Порт отпускается не мгновенно — даём ОС дожить сокеты, потом перепроверяем.
  await new Promise((sleep) => setTimeout(sleep, 400));
  const after = await describePort(port, isOurs);
  return { ...after, killed };
}

/** Открыть URL в браузере ОС. Инъектируется в реестр — тест подставит заглушку. */
export function openBrowser(url: string): void {
  const child =
    process.platform === 'darwin'
      ? spawn('open', [url], { stdio: 'ignore', detached: true })
      : isWindows
        ? // cmd start: первый пустой аргумент — это заголовок окна, иначе URL
          // с пробелами будет принят за заголовок.
          spawn('cmd', ['/c', 'start', '', url], {
            stdio: 'ignore',
            detached: true,
            windowsHide: true,
          })
        : spawn('xdg-open', [url], { stdio: 'ignore', detached: true });
  child.unref();
}

/** Убить дерево процессов: Windows — taskkill /T /F, POSIX — по группе. */
function killTree(pid: number): void {
  if (isWindows) {
    spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true });
    return;
  }
  try {
    process.kill(-pid, 'SIGTERM');
  } catch {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // Процесса уже нет — нечего убивать.
    }
  }
}

/** Нормализация пути для ключа реестра (Windows нечувствителен к регистру/слэшам). */
function normalizePath(path: string): string {
  const unified = resolve(path).replace(/\\/g, '/').replace(/\/+$/, '');
  return isWindows ? unified.toLowerCase() : unified;
}

/**
 * Подпапка цели: только относительный путь вниз. Абсолютный путь и `..` —
 * отказ, а не «как-нибудь разберёмся»: каталог запуска обязан лежать внутри
 * проекта, иначе панель запускает что угодно на диске.
 */
export function resolveTargetDir(projectPath: string, dir?: string): { dir: string; path: string } {
  const clean = (dir ?? '')
    .trim()
    .replace(/\\/g, '/')
    .replace(/^\/+|\/+$/g, '');
  if (!clean) return { dir: '', path: resolve(projectPath) };
  if (
    clean.split('/').some((part) => part === '..') ||
    /^[a-zA-Z]:/.test(clean) ||
    dir?.[0] === '/'
  )
    throw new RunnerError('bad-path', `Подпапка должна лежать внутри проекта: ${dir ?? ''}`);
  return { dir: clean, path: resolve(projectPath, clean) };
}

/** Каталог проекта существует и это каталог, иначе — текст проблемы. */
function checkDir(dir: string): string | null {
  if (!dir.trim()) return 'Путь к проекту не задан';
  if (!existsSync(dir)) return `Каталог не существует: ${dir}`;
  if (!isDirectory(dir)) return `Это не каталог: ${dir}`;
  return null;
}

interface RunEntry {
  projectPath: string;
  dir: string;
  path: string;
  name: string;
  port?: number;
  url?: string;
  status: ProjectRunnerStatus;
  command: string;
  startedAt: string;
  error?: string;
  /** Порт, на который сервер пожаловался «уже занят». */
  busyPort?: number;
  child?: ChildProcess;
  /** Мы сами останавливаем — не превращать выход процесса в ошибку. */
  stopping: boolean;
  /** Автозапуск: браузер не открывать (окно всплыло бы само, без просьбы). */
  silent: boolean;
  /** Порт задан пользователем — из вывода его не переопределяем. */
  pinned: boolean;
  /** Хвост вывода: и для разбора адреса, и для показа в панели. */
  output: string;
}

/** Цель запуска в запросе: корень вкладки плюс подпапка. */
export interface RunnerTargetRef {
  projectPath: string;
  dir?: string;
}

/** Опции реестра: инъекции для тестов и связь с состоянием панели. */
export interface RunnerDeps {
  /** Открытие браузера — заглушка в тестах. */
  openBrowser?: (url: string) => void;
  /** Как получить команду запуска — тест подставит запуск node напрямую. */
  resolveLaunch?: (targetDir: string, override?: string, projectRoot?: string) => LaunchSpec;
  /**
   * Порт определился — панель его запоминает. Реестр не знает, где хранится
   * состояние, поэтому получает узкий колбэк, а не `AppStore`.
   */
  onPortDiscovered?: (run: { projectPath: string; dir: string; port: number }) => void;
  /** Сколько ждать адреса. Тест укорачивает — иначе ждал бы полминуты. */
  readyTimeoutMs?: number;
}

/**
 * Что автозапуску нужно от состояния панели. Узкий интерфейс вместо импорта
 * `AppStore`: реестр не должен ничего знать о том, где панель хранит состояние.
 */
export interface AutostartMemory {
  listAutostartProjects(): {
    path: string;
    projectPath?: string;
    dir?: string;
    command?: string;
    pinnedPort?: number;
  }[];
}

/** Итог автозапуска — для строчки в консоли при старте панели. */
export interface AutostartReport {
  started: { path: string; port?: number }[];
  failed: { path: string; message: string }[];
}

/**
 * Поднять dev-серверы целей, отмеченных автозапуском. Вызывается один раз при
 * старте сервера панели.
 *
 * Два обещания: браузер не открывается; ни одна неудача не роняет старт панели
 * (каталог могли удалить, скрипт — убрать).
 */
export async function autostartProjects(
  registry: ProjectRunnerRegistry,
  memory: AutostartMemory,
): Promise<AutostartReport> {
  const report: AutostartReport = { started: [], failed: [] };
  for (const prefs of memory.listAutostartProjects()) {
    try {
      const view = await registry.start(
        { projectPath: prefs.projectPath ?? prefs.path, dir: prefs.dir },
        { command: prefs.command, port: prefs.pinnedPort, openBrowser: false },
      );
      report.started.push({ path: view.path, port: view.port });
    } catch (error) {
      report.failed.push({
        path: prefs.path,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return report;
}

export class ProjectRunnerRegistry {
  private runs = new Map<string, RunEntry>();
  private readonly openBrowser: (url: string) => void;
  private readonly resolveLaunch: (
    targetDir: string,
    override?: string,
    projectRoot?: string,
  ) => LaunchSpec;
  private readonly onPortDiscovered?: (run: {
    projectPath: string;
    dir: string;
    port: number;
  }) => void;
  private readonly readyTimeoutMs: number;

  constructor(deps: RunnerDeps = {}) {
    // Node исполняет TS в strip-only режиме — parameter properties не работают.
    this.openBrowser = deps.openBrowser ?? openBrowser;
    this.resolveLaunch = deps.resolveLaunch ?? resolveRunCommand;
    this.onPortDiscovered = deps.onPortDiscovered;
    this.readyTimeoutMs = deps.readyTimeoutMs ?? READY_TIMEOUT_MS;
  }

  /** Список запущенных серверов — для клиента (поллинг). */
  list(): ProjectRunnerView[] {
    return [...this.runs.values()].map((entry) => this.view(entry));
  }

  /**
   * Наш ли процесс на этом порту. Прямого потомка узнаём по PID; но слушает
   * обычно внук (`pnpm` → `node vite`), поэтому засчитываем и совпадение порта
   * с нашим живым запуском — двое на одном порту не слушают.
   */
  ownsPid(pid: number, port?: number): boolean {
    return [...this.runs.values()].some(
      (entry) =>
        entry.child?.pid === pid ||
        (port !== undefined && entry.port === port && entry.status !== 'error'),
    );
  }

  /** Состояние одной цели или undefined, если она не запускалась. */
  get(target: RunnerTargetRef): ProjectRunnerView | undefined {
    const { path } = resolveTargetDir(target.projectPath, target.dir);
    const entry = this.runs.get(normalizePath(path));
    return entry ? this.view(entry) : undefined;
  }

  /**
   * Бронь ключа на время старта: запись без процесса в стадии `starting`.
   * Нужна, чтобы параллельный запрос увидел «уже запускается» и не поднял
   * второй сервер. Снимается при любом отказе до спавна.
   */
  private reservation(root: string, dir: string, path: string, command: string): RunEntry {
    return {
      projectPath: root,
      dir,
      path,
      name: readPackageJson(path)?.name ?? basename(path),
      status: 'starting',
      command,
      startedAt: new Date().toISOString(),
      stopping: false,
      silent: false,
      pinned: false,
      output: '',
    };
  }

  /**
   * Запустить dev-сервер цели. Возвращает состояние сразу со стадией `starting`;
   * адрес и открытие браузера идут в фоне. Уже запущенную цель отдаём как есть,
   * второй процесс не плодим.
   *
   * `options.port` — закреплённый пользователем порт: он уходит в `PORT` и
   * ожидание идёт по нему. Не задан — порт читается из вывода сервера.
   * `options.openBrowser: false` — автозапуск при старте панели: сервер
   * поднимается молча, окно браузера не открывается.
   */
  async start(
    target: RunnerTargetRef,
    options: { command?: string; port?: number; openBrowser?: boolean } = {},
  ): Promise<ProjectRunnerView> {
    const root = resolve(target.projectPath);
    const { dir, path } = resolveTargetDir(root, target.dir);
    const key = normalizePath(path);

    const existing = this.runs.get(key);
    if (existing && (existing.status === 'starting' || existing.status === 'running')) {
      return this.view(existing);
    }

    const problem = checkDir(path);
    if (problem) throw new RunnerError('bad-path', problem);

    const launch = this.resolveLaunch(path, options.command, root);

    // Занимаем ключ ДО первого await. Между проверкой занятости порта и записью
    // в реестр успевает пройти второй запрос (два клика, автозапуск поверх
    // ручного старта) — и тогда поднимались бы два процесса, а реестр помнил бы
    // только последний: первый становился сиротой и держал порт.
    const held = this.reservation(root, dir, path, launch.display);
    this.runs.set(key, held);

    const pinned =
      options.port && Number.isInteger(options.port) && options.port > 0 && options.port < 65_536
        ? options.port
        : undefined;
    // Закреплённый порт уже кем-то занят — почти наверняка тем же сервером,
    // запущенным мимо панели. Промолчать нельзя: TCP-проба тут же увидела бы
    // «слушает» и объявила чужой процесс нашим.
    if (pinned !== undefined && (await isPortBusy(pinned))) {
      // Бронь снимаем: запуска не будет, а «вечно запускается» в панели хуже
      // честной ошибки.
      this.runs.delete(key);
      throw new RunnerError(
        'port-busy',
        `Порт ${pinned} уже занят — возможно, сервер уже запущен вне панели.`,
        pinned,
      );
    }

    // Имя команды НЕ дополняем `.cmd`: запуск идёт через оболочку, а cmd.exe сам
    // разрешает имя по PATHEXT — `pnpm` находит `pnpm.cmd`. Дополнение же было
    // фатальным для всего, что ставится как `.exe` (`node`, `python`, `deno`):
    // `node.cmd` не существует, и своя команда пользователя падала сразу.
    // Полный путь (с разделителями или пробелами) по-прежнему квотируем: без
    // кавычек `C:\Program Files\...` развалился бы на несколько аргументов.
    const bare = /^[a-zA-Z0-9._-]+$/.test(launch.file);
    const file = isWindows && !bare ? quoteForShell(launch.file) : launch.file;

    // PORT передаём ТОЛЬКО когда пользователь закрепил порт. Без этого панель
    // навязывала бы адрес тем, кто его и так знает из своего конфига, — включая
    // собственный PORT сервера панели, который иначе утёк бы в каждый dev-сервер
    // по наследству от process.env.
    const env = { ...process.env, BROWSER: 'none', FORCE_COLOR: '0' } as NodeJS.ProcessEnv;
    if (pinned === undefined) delete env.PORT;
    else env.PORT = String(pinned);

    let child: ChildProcess;
    try {
      child = spawn(file, shellArgs(launch.args), {
        cwd: path,
        shell: isWindows,
        windowsHide: true,
        // POSIX: своя группа процессов, чтобы убить всё дерево через kill(-pid).
        detached: !isWindows,
        env,
      });
    } catch (error) {
      // Спавн бросает синхронно (нет прав на каталог, кривой путь) — бронь снимаем,
      // иначе цель навсегда осталась бы в стадии «запускается».
      this.runs.delete(key);
      throw error;
    }

    const entry: RunEntry = {
      projectPath: root,
      dir,
      path,
      name: readPackageJson(path)?.name ?? basename(path),
      port: pinned,
      status: 'starting',
      command: launch.display,
      // Время старта берём у брони: параллельный запрос уже получил её вид, и
      // разное время у одного и того же запуска сбивало бы клиента с толку.
      startedAt: held.startedAt,
      child,
      stopping: false,
      silent: options.openBrowser === false,
      pinned: pinned !== undefined,
      output: '',
    };
    this.runs.set(key, entry);

    // Адрес печатают и в stdout (Vite, Next), и в stderr (некоторые сборки), —
    // читаем оба потока одинаково.
    const absorb = (chunk: Buffer): void => {
      entry.output = (entry.output + chunk.toString()).slice(-OUTPUT_TAIL);
      if (entry.port === undefined) {
        const port = extractServerPort(entry.output);
        if (port !== undefined) entry.port = port;
      }
      // Сервер сам сказал, что порт занят: запомним — панель предложит
      // освободить его и запустить заново.
      entry.busyPort ??= extractBusyPort(entry.output);
    };
    child.stdout?.on('data', absorb);
    child.stderr?.on('data', absorb);

    child.on('error', (err) => {
      if (entry.stopping) return;
      entry.status = 'error';
      entry.error = err.message;
    });

    child.on('exit', (code) => {
      if (entry.stopping) return;
      // Процесс упал сам, не дойдя до готовности (или после) — это ошибка.
      if (entry.status === 'starting' || entry.status === 'running') {
        entry.status = 'error';
        entry.error = lastLines(entry.output) || `Процесс завершился с кодом ${code}`;
      }
    });

    void this.awaitReady(entry);
    return this.view(entry);
  }

  /**
   * Дождаться, пока станет известен адрес и порт начнёт слушать.
   *
   * Не дождались, а процесс жив — это НЕ ошибка: бывают серверы, которые адреса
   * не печатают (воркеры, бэкенды с логом в файл). Такой запуск остаётся
   * работающим, просто без ссылки, и пользователь может закрепить порт руками.
   * Убиваем только то, что умерло само.
   */
  private async awaitReady(entry: RunEntry): Promise<void> {
    const deadline = Date.now() + this.readyTimeoutMs;

    while (Date.now() < deadline) {
      if (entry.stopping || entry.status === 'stopped' || entry.status === 'error') return;

      const port = entry.port;
      if (port !== undefined && (await probeConnect(port))) {
        entry.status = 'running';
        entry.url = `http://localhost:${port}`;
        this.onPortDiscovered?.({ projectPath: entry.projectPath, dir: entry.dir, port });
        if (!entry.silent) this.openBrowser(entry.url);
        return;
      }

      await new Promise((sleep) => setTimeout(sleep, READY_POLL_MS));
    }

    if (entry.stopping || entry.status !== 'starting') return;

    if (entry.child && entry.child.exitCode === null && entry.child.signalCode === null) {
      // Работает, но адреса не назвал. Порт мог быть закреплён и всё ещё не
      // подняться — тогда ссылки тоже нет, но и врать про готовность незачем.
      entry.status = 'running';
      entry.url = undefined;
      return;
    }

    entry.status = 'error';
    entry.error = lastLines(entry.output) || 'Процесс завершился, не начав слушать порт';
  }

  /** Остановить сервер цели: убить дерево процессов и убрать из реестра. */
  stop(target: RunnerTargetRef): boolean {
    const { path } = resolveTargetDir(target.projectPath, target.dir);
    const key = normalizePath(path);
    const entry = this.runs.get(key);
    if (!entry) return false;
    this.killEntry(entry);
    this.runs.delete(key);
    return true;
  }

  /** Остановить все серверы — вызывается при выходе сервера панели. */
  stopAll(): void {
    for (const key of [...this.runs.keys()]) {
      const entry = this.runs.get(key);
      if (entry) this.killEntry(entry);
      this.runs.delete(key);
    }
  }

  private killEntry(entry: RunEntry): void {
    entry.stopping = true;
    entry.status = 'stopped';
    if (entry.child?.pid) killTree(entry.child.pid);
  }

  private view(entry: RunEntry): ProjectRunnerView {
    return {
      projectPath: entry.projectPath,
      dir: entry.dir,
      path: entry.path,
      name: entry.name,
      port: entry.port,
      url: entry.url,
      status: entry.status,
      command: entry.command,
      startedAt: entry.startedAt,
      error: entry.error,
      busyPort: entry.busyPort,
      output: lastLines(entry.output),
    };
  }
}

/** Хвост вывода для показа: последние непустые строки без управляющих кодов. */
function lastLines(output: string, count = 12): string {
  return output
    .replace(ANSI, '')
    .split(/\r?\n/)
    .filter((line) => line.trim())
    .slice(-count)
    .join('\n')
    .trim();
}
