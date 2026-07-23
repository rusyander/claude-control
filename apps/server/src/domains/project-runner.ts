import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createServer, createConnection } from 'node:net';
import { existsSync, statSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type {
  ProjectRunnerInfo,
  ProjectRunnerStatus,
  ProjectRunnerView,
} from '@claude-control/contracts';
import { shellArgs, quoteForShell } from '../lib/cli-args.ts';

/**
 * Запуск и остановка dev-сервера проекта прямо из панели.
 *
 * Реестр запущенных серверов держится в памяти: путь проекта → процесс, порт,
 * URL и стадия. Готовность определяется TCP-пробой порта; как только он начал
 * слушать — открывается браузер ОС. Много вкладок → много серверов, у каждого
 * свой свободный порт.
 *
 * Чистые части (выбор команды и пакетного менеджера, разбор строки, поиск
 * свободного порта) вынесены отдельными функциями — их проверяют тесты без
 * настоящего dev-сервера. Открытие браузера инъектируется, чтобы тест его не звал.
 */

const isWindows = process.platform === 'win32';

/** Порт, с которого начинаем искать свободный. */
const BASE_PORT = 4300;
/** Сколько ждём готовности порта, прежде чем признать запуск неудачным. */
const READY_TIMEOUT_MS = 30_000;
/** Шаг опроса порта при ожидании готовности. */
const READY_POLL_MS = 300;
/** Локальный интерфейс — панель и её серверы только на localhost. */
const HOST = '127.0.0.1';

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
  code: 'bad-path' | 'no-script';
  constructor(code: 'bad-path' | 'no-script', message: string) {
    super(message);
    this.code = code;
    this.name = 'RunnerError';
  }
}

/** Пакетный менеджер по lock-файлу: pnpm-lock → pnpm, yarn.lock → yarn, иначе npm. */
export function detectPackageManager(projectDir: string): PackageManager {
  if (existsSync(join(projectDir, 'pnpm-lock.yaml'))) return 'pnpm';
  if (existsSync(join(projectDir, 'yarn.lock'))) return 'yarn';
  return 'npm';
}

/** Прочитать package.json проекта; при отсутствии/битом файле — undefined. */
function readPackageJson(projectDir: string): { scripts?: Record<string, string> } | undefined {
  try {
    return JSON.parse(readFileSync(join(projectDir, 'package.json'), 'utf8')) as {
      scripts?: Record<string, string>;
    };
  } catch {
    return undefined;
  }
}

/** Скрипт запуска: `dev`, иначе `start`, иначе ничего. */
export function detectRunScript(projectDir: string): 'dev' | 'start' | undefined {
  const scripts = readPackageJson(projectDir)?.scripts ?? {};
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
export function resolveRunCommand(projectDir: string, override?: string): LaunchSpec {
  const trimmed = override?.trim();
  if (trimmed) {
    const [file, ...args] = tokenize(trimmed);
    if (!file) throw new RunnerError('no-script', 'Команда запуска пуста.');
    return { file, args, display: trimmed };
  }

  const script = detectRunScript(projectDir);
  if (!script) {
    throw new RunnerError(
      'no-script',
      'В package.json проекта нет скрипта dev или start. Задайте команду запуска в оверрайде.',
    );
  }
  const pm = detectPackageManager(projectDir);
  return { file: pm, args: ['run', script], display: `${pm} run ${script}` };
}

/** Можно ли запустить проект и какой командой — для подсказки на кнопке. */
export function describeRunner(projectDir: string, override?: string): ProjectRunnerInfo {
  try {
    const spec = resolveRunCommand(projectDir, override);
    return { runnable: true, command: spec.display };
  } catch (error) {
    return { runnable: false, reason: error instanceof Error ? error.message : String(error) };
  }
}

/** Каталог проекта существует и это каталог, иначе — текст проблемы. */
function checkDir(projectDir: string): string | null {
  if (!projectDir.trim()) return 'Путь к проекту не задан';
  if (!existsSync(projectDir)) return `Каталог проекта не существует: ${projectDir}`;
  try {
    if (!statSync(projectDir).isDirectory()) return `Это не каталог: ${projectDir}`;
  } catch {
    return `Каталог проекта недоступен: ${projectDir}`;
  }
  return null;
}

/**
 * Свободный порт начиная с `preferred`, пропуская уже занятые нами (`taken`) и
 * те, что не отдаёт ОС (net-проба с инкрементом). Проба закрывает свой слушатель
 * сразу — порт займёт уже сам dev-сервер.
 */
export function findFreePort(preferred: number, taken: Set<number> = new Set()): Promise<number> {
  const probe = (port: number, left: number): Promise<number> =>
    new Promise((resolvePort, reject) => {
      if (taken.has(port)) {
        resolvePort(probe(port + 1, left - 1));
        return;
      }
      const server = createServer();
      server.once('error', (err: NodeJS.ErrnoException) => {
        server.close();
        if (err.code === 'EADDRINUSE' && left > 0) resolvePort(probe(port + 1, left - 1));
        else reject(err);
      });
      server.once('listening', () => server.close(() => resolvePort(port)));
      server.listen(port, HOST);
    });
  return probe(preferred, 200);
}

/** Одна попытка TCP-подключения к порту: слушает он или нет. */
function probeConnect(port: number): Promise<boolean> {
  return new Promise((resolveProbe) => {
    const socket = createConnection({ port, host: HOST });
    const settle = (ok: boolean): void => {
      socket.destroy();
      resolveProbe(ok);
    };
    socket.once('connect', () => settle(true));
    socket.once('error', () => settle(false));
    socket.setTimeout(1000, () => settle(false));
  });
}

/** Ждать, пока порт начнёт слушать, но не дольше таймаута. */
async function waitForPort(port: number, totalMs: number, signal: () => boolean): Promise<boolean> {
  const deadline = Date.now() + totalMs;
  while (Date.now() < deadline) {
    if (signal()) return false;
    if (await probeConnect(port)) return true;
    await new Promise((r) => setTimeout(r, READY_POLL_MS));
  }
  return false;
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

interface RunEntry {
  path: string;
  port: number;
  url: string;
  status: ProjectRunnerStatus;
  command: string;
  startedAt: string;
  error?: string;
  child?: ChildProcess;
  /** Мы сами останавливаем — не превращать выход процесса в ошибку. */
  stopping: boolean;
}

/** Опции реестра: инъекции для тестов. */
export interface RunnerDeps {
  /** Открытие браузера — заглушка в тестах. */
  openBrowser?: (url: string) => void;
  /** Как получить команду запуска — тест подставит запуск node напрямую. */
  resolveLaunch?: (projectDir: string, override?: string) => LaunchSpec;
}

export class ProjectRunnerRegistry {
  private runs = new Map<string, RunEntry>();
  private readonly openBrowser: (url: string) => void;
  private readonly resolveLaunch: (projectDir: string, override?: string) => LaunchSpec;

  constructor(deps: RunnerDeps = {}) {
    // Node исполняет TS в strip-only режиме — parameter properties не работают.
    this.openBrowser = deps.openBrowser ?? openBrowser;
    this.resolveLaunch = deps.resolveLaunch ?? resolveRunCommand;
  }

  /** Список запущенных серверов — для клиента (поллинг). */
  list(): ProjectRunnerView[] {
    return [...this.runs.values()].map((entry) => this.view(entry));
  }

  /** Состояние одного проекта или undefined, если не запускался. */
  get(projectPath: string): ProjectRunnerView | undefined {
    const entry = this.runs.get(normalizePath(projectPath));
    return entry ? this.view(entry) : undefined;
  }

  /**
   * Запустить dev-сервер проекта. Возвращает состояние сразу со стадией
   * `starting`; готовность и открытие браузера идут в фоне. Уже запущенный —
   * отдаём как есть, второй процесс не плодим.
   */
  async start(projectPath: string, override?: string): Promise<ProjectRunnerView> {
    const key = normalizePath(projectPath);
    const existing = this.runs.get(key);
    if (existing && (existing.status === 'starting' || existing.status === 'running')) {
      return this.view(existing);
    }

    const problem = checkDir(projectPath);
    if (problem) throw new RunnerError('bad-path', problem);

    const launch = this.resolveLaunch(projectPath, override);
    const port = await findFreePort(BASE_PORT, this.takenPorts());
    const url = `http://localhost:${port}`;

    // На Windows пакетные менеджеры (pnpm/npm/yarn) — это .cmd-обёртки, а запуск
    // идёт через оболочку. Голое имя команды дополняем .cmd, полный путь (с
    // разделителями/пробелами) — квотируем: без кавычек путь вида
    // `C:\Program Files\...` развалился бы на несколько аргументов.
    const bare = /^[a-zA-Z0-9._-]+$/.test(launch.file);
    const file = isWindows
      ? bare
        ? `${launch.file}.cmd`
        : quoteForShell(launch.file)
      : launch.file;
    const child = spawn(file, shellArgs(launch.args), {
      cwd: resolve(projectPath),
      shell: isWindows,
      windowsHide: true,
      // POSIX: своя группа процессов, чтобы убить всё дерево через kill(-pid).
      detached: !isWindows,
      env: { ...process.env, PORT: String(port), BROWSER: 'none' },
    });

    const entry: RunEntry = {
      path: resolve(projectPath),
      port,
      url,
      status: 'starting',
      command: launch.display,
      startedAt: new Date().toISOString(),
      child,
      stopping: false,
    };
    this.runs.set(key, entry);

    const stderr: string[] = [];
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr.push(chunk.toString());
      if (stderr.length > 50) stderr.shift();
    });

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
        entry.error = stderr.join('').trim() || `Процесс завершился с кодом ${code}`;
      }
    });

    void this.awaitReady(entry);
    return this.view(entry);
  }

  /** Дождаться готовности порта и открыть браузер, либо пометить ошибкой. */
  private async awaitReady(entry: RunEntry): Promise<void> {
    const ready = await waitForPort(entry.port, READY_TIMEOUT_MS, () => entry.stopping);
    if (entry.stopping || entry.status === 'stopped') return;
    if (entry.status === 'error') return;

    if (ready) {
      entry.status = 'running';
      this.openBrowser(entry.url);
    } else {
      entry.status = 'error';
      entry.error = `Сервер не начал слушать порт ${entry.port} за ${READY_TIMEOUT_MS / 1000} с`;
      this.killEntry(entry);
    }
  }

  /** Остановить сервер проекта: убить дерево процессов и убрать из реестра. */
  stop(projectPath: string): boolean {
    const key = normalizePath(projectPath);
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

  /** Порты, занятые нашими живыми серверами, — чтобы не выдать один дважды. */
  private takenPorts(): Set<number> {
    const ports = new Set<number>();
    for (const entry of this.runs.values()) {
      if (entry.status === 'starting' || entry.status === 'running') ports.add(entry.port);
    }
    return ports;
  }

  private view(entry: RunEntry): ProjectRunnerView {
    return {
      path: entry.path,
      port: entry.port,
      url: entry.url,
      status: entry.status,
      command: entry.command,
      startedAt: entry.startedAt,
      error: entry.error,
    };
  }
}
