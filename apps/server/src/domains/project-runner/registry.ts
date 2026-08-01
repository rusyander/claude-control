import { spawn, type ChildProcess } from 'node:child_process';
import { basename, resolve } from 'node:path';
import type { ProjectRunnerView } from '@claude-control/contracts';
import { shellArgs, quoteForShell } from '../../lib/cli-args.ts';
import {
  OUTPUT_TAIL,
  READY_POLL_MS,
  READY_TIMEOUT_MS,
  isWindows,
} from './project-runner.constants.ts';
import {
  RunnerError,
  type LaunchSpec,
  type RunEntry,
  type RunnerDeps,
  type RunnerTargetRef,
} from './project-runner.types.ts';
import { extractBusyPort, extractServerPort, lastLines } from './output.ts';
import { isPortBusy } from './ports.ts';
import { killTree, openBrowser } from './os-process.ts';
import { readPackageJson, resolveRunCommand } from './stack.ts';
import { checkDir, normalizePath, resolveTargetDir } from './targets.ts';

/**
 * Реестр запущенных dev-серверов: ключ — абсолютный путь каталога запуска.
 * Здесь только жизненный цикл процесса; разбор вывода, пробы порта и выбор
 * команды живут в соседних модулях.
 */
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
      // Имя уже прочитано для брони — второй раз тот же package.json не читаем.
      name: held.name,
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
      if (port !== undefined && (await isPortBusy(port))) {
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
