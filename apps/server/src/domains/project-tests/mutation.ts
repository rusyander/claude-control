import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmdirSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, extname, isAbsolute, join, normalize, relative, sep } from 'node:path';
import type {
  ProjectTestMutationCandidate,
  ProjectTestMutationCase,
  ProjectTestMutationCheck,
  ProjectTestMutationMode,
} from '@agentdeck/contracts';
import { coded } from '../../lib/server-text.ts';
import type { ServerMessageCode } from '@agentdeck/contracts';
import { killChildTree } from '../../lib/process-tree.ts';
import { git } from '../project-git/exec.ts';
import { automationCommand, readAutomation } from './automation.ts';
import { e2eCommand } from './e2e-command.ts';
import { e2eFolderView } from './e2e-folder.ts';
import { ProjectTestsError } from './files.ts';
import { prepareResultsForRun } from './import-results.ts';
import { readGroups } from './store.ts';

/**
 * Проверка набора кейсов поломкой (решение владельца 30.09). Единственный
 * честный ответ на «а поймают ли эти кейсы регрессию»: в ОТДЕЛЬНОЙ копии
 * репозитория файл заведомо ломается, привязанные к нему автоматические кейсы
 * прогоняются, и отчёт называет, какие покраснели, а какие нет. Не покраснел ни
 * один — файл кейсами не защищён.
 *
 * Дорого по времени, поэтому только по кнопке человека и по одной на проект.
 * Рабочая копия человека не трогается: копия — `git worktree --detach` в каталоге
 * данных панели с незакоммиченными правками поверх, зависимости — ссылками на
 * `node_modules`/`.venv` оригинала. Библиотека и история не меняются: отчёт
 * живёт в памяти панели, статусы кейсов остаются от настоящих прогонов.
 */

/** Сколько вывода команды держать в отчёте. */
const LOG_LIMIT = 20_000;
/** Потолок прогона, когда `automation.json` своего не назвал. */
const DEFAULT_TIMEOUT_MINUTES = 30;
/** Каталоги зависимостей, которые копия получает ссылкой, а не установкой. */
const DEPENDENCY_DIRS = new Set(['node_modules', '.venv', 'venv']);
/** Насколько глубоко искать их в оригинале (монорепозиторий: apps/x/node_modules). */
const DEPENDENCY_DEPTH = 3;

/** Сколько ждать выхода команды после мягкой остановки, прежде чем снять её жёстко. */
const KILL_GRACE_MS = 5_000;
/** Сколько дочитывать вывод после выхода команды, если его держит её помощник. */
const EXIT_DRAIN_MS = 2_000;
/** Каталог копий проверок в каталоге данных панели. */
const COPIES_DIR = 'mutation-copies';

const SCRIPT = new Set(['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs']);

type Spawner = (line: string, cwd: string, env: NodeJS.ProcessEnv) => ChildProcess;

const defaultSpawn: Spawner = (line, cwd, env) =>
  spawn(line, {
    cwd,
    env,
    shell: true,
    windowsHide: true,
    detached: process.platform !== 'win32',
  });

type MutationCode = Extract<ServerMessageCode, `mutation-${string}`>;

function failure(message: string, code: MutationCode, params?: Record<string, string>): Error {
  return coded(new ProjectTestsError(message), code, params);
}

/** Путь файла кейса совпадает с `codePaths`: сам файл или его каталог. */
function covers(codePath: string, file: string): boolean {
  const needle = codePath.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');
  return file === needle || file.startsWith(`${needle}/`);
}

/** Автоматические кейсы, привязанные к файлу через `codePaths`. */
export function casesForFile(root: string, file: string): ProjectTestMutationCase[] {
  const cases: ProjectTestMutationCase[] = [];
  for (const group of readGroups(root)) {
    if (group.error) continue;
    for (const item of group.cases) {
      if (item.archived || item.automation?.status !== 'automated' || !item.automation.file) {
        continue;
      }
      if ((item.codePaths ?? []).some((path) => covers(path, file))) {
        cases.push({
          groupId: group.id,
          caseId: item.id,
          title: item.title,
          automationFile: item.automation.file,
          status: 'no-result',
        });
      }
    }
  }
  return cases;
}

/**
 * Файлы, которые есть что ломать: файлы `codePaths` автоматических кейсов,
 * существующие в проекте. Каталог в `codePaths` целиком не ломается — его
 * файлы человек назовёт сам.
 */
export function mutationCandidates(root: string): ProjectTestMutationCandidate[] {
  const counts = new Map<string, number>();
  for (const group of readGroups(root)) {
    if (group.error) continue;
    for (const item of group.cases) {
      if (item.archived || item.automation?.status !== 'automated') continue;
      for (const path of item.codePaths ?? []) {
        const file = path.replace(/\\/g, '/').replace(/^\.\//, '');
        try {
          if (!statSync(join(root, file)).isFile()) continue;
        } catch {
          continue;
        }
        counts.set(file, (counts.get(file) ?? 0) + 1);
      }
    }
  }
  return [...counts]
    .map(([file, cases]) => ({ file, cases }))
    .sort((a, b) => b.cases - a.cases || a.file.localeCompare(b.file));
}

/**
 * Заведомая поломка файла. `break` — грубая: модуль падает при загрузке (у
 * кода) или файл пустеет (у данных) — её обязан поймать любой кейс, который этот
 * файл вообще исполняет. `subtle` — тонкая: первое сравнение или логическое
 * значение переворачивается; её ловят только кейсы, проверяющие поведение, а
 * не то, что страница открылась. Перевернуть нечего — `undefined`.
 */
export function breakFile(
  text: string,
  file: string,
  mode: ProjectTestMutationMode,
): { text: string; description: string } | undefined {
  const ext = extname(file).toLowerCase();
  if (mode === 'subtle') {
    const flips: [RegExp, (match: string) => string][] = [
      [/===|!==/, (match) => (match === '===' ? '!==' : '===')],
      [/\b(true|false)\b/, (match) => (match === 'true' ? 'false' : 'true')],
      [/&&|\|\|/, (match) => (match === '&&' ? '||' : '&&')],
      [/(?<![=<>!])(<=|>=)(?!=)/, (match) => (match === '<=' ? '>' : '<')],
    ];
    const lines = text.split('\n');
    for (const [pattern, flip] of flips) {
      for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index] ?? '';
        const code = line.replace(/(\/\/|#).*$/, '');
        const match = pattern.exec(code);
        if (!match) continue;
        const next = `${line.slice(0, match.index)}${flip(match[0])}${line.slice(match.index + match[0].length)}`;
        lines[index] = next;
        return {
          text: lines.join('\n'),
          description: `line ${index + 1}: ${line.trim().slice(0, 120)} → ${next.trim().slice(0, 120)}`,
        };
      }
    }
    return undefined;
  }
  if (SCRIPT.has(ext)) {
    return {
      text: `throw new Error('agentdeck mutation check: ${file} is broken on purpose');\n${text}`,
      description: 'module throws on load',
    };
  }
  if (ext === '.py') {
    return {
      text: `raise RuntimeError("agentdeck mutation check: ${file} is broken on purpose")\n${text}`,
      description: 'module raises on import',
    };
  }
  return { text: '', description: 'file emptied' };
}

/** Каталоги зависимостей оригинала — по относительному пути. */
function dependencyDirs(root: string, rel = '', depth = 0, out: string[] = []): string[] {
  let entries;
  try {
    entries = readdirSync(join(root, rel), { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const path = rel ? `${rel}/${entry.name}` : entry.name;
    if (DEPENDENCY_DIRS.has(entry.name)) out.push(path);
    else if (depth < DEPENDENCY_DEPTH && entry.name !== '.git' && !entry.name.startsWith('.')) {
      dependencyDirs(root, path, depth + 1, out);
    }
  }
  return out;
}

export interface MutationStart {
  root: string;
  appData: string;
  /** Файл от корня проекта. */
  file: string;
  mode?: ProjectTestMutationMode;
  now?: () => string;
}

interface Live {
  view: ProjectTestMutationCheck;
  child?: ChildProcess;
  copy?: string;
  /** Ссылки, заведённые в копии, — снимаются первыми, до удаления копии. */
  links: string[];
  timer?: NodeJS.Timeout;
  stopped?: boolean;
  /** Копия снимается (или остановленный прогон ещё до неё не дошёл): папка и запись worktree заняты. */
  cleaning?: boolean;
}

/** Ссылка в копию: каталог — `junction` на Windows, запоминается для уборки. */
function link(live: Live, from: string, to: string): void {
  mkdirSync(dirname(to), { recursive: true });
  symlinkSync(from, to, process.platform === 'win32' ? 'junction' : 'dir');
  live.links.push(to);
}

/** Снять ссылку, не трогая то, на что она указывает. */
function unlink(path: string): void {
  try {
    unlinkSync(path);
  } catch {
    try {
      rmdirSync(path);
    } catch {
      // Ссылки уже нет.
    }
  }
}

/** Ссылки внутри копии — чтобы снять их, не зная, кто их завёл (копия прошлого запуска). */
function linksIn(dir: string, depth = 0, out: string[] = []): string[] {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isSymbolicLink()) out.push(path);
    else if (entry.isDirectory() && depth < DEPENDENCY_DEPTH + 2 && entry.name !== '.git') {
      linksIn(path, depth + 1, out);
    }
  }
  return out;
}

/** Удалить копию: сперва ссылки (без захода по ним), потом worktree, потом каталог. */
async function dropCopy(root: string | undefined, copy: string, links: string[]): Promise<void> {
  for (const path of [...links, ...linksIn(copy)]) unlink(path);
  if (root) await git(root, ['worktree', 'remove', '--force', copy]).catch(() => '');
  try {
    rmSync(copy, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  } catch {
    // Занят (антивирус, снятый процесс) — останется до следующей уборки при старте.
  }
  if (root) await git(root, ['worktree', 'prune']).catch(() => '');
}

/** Репозиторий, чья это копия: `.git` копии — файл `gitdir: <repo>/.git/worktrees/<id>`. */
function repoOfCopy(copy: string): string | undefined {
  try {
    const pointer = /^gitdir:\s*(.+)$/m.exec(readFileSync(join(copy, '.git'), 'utf8'))?.[1];
    const at = pointer?.trim().replace(/\\/g, '/').lastIndexOf('/.git/worktrees/');
    return pointer && at !== undefined && at > 0 ? pointer.trim().slice(0, at) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Уборка при старте панели: копии проверок, оборванных выходом панели или её
 * падением. Без неё в репозитории человека копились бы записи worktree, а в
 * каталоге данных — копии со ссылками на его `node_modules`.
 */
export async function sweepMutationCopies(appData: string): Promise<number> {
  const dir = join(appData, COPIES_DIR);
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  let swept = 0;
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (!entry.isDirectory()) {
      rmSync(path, { force: true });
      continue;
    }
    await dropCopy(repoOfCopy(path), path, []);
    swept += 1;
  }
  return swept;
}

export class MutationChecks {
  private readonly checks = new Map<string, Live>();
  private readonly spawnImpl: Spawner;

  constructor(spawnImpl: Spawner = defaultSpawn) {
    this.spawnImpl = spawnImpl;
  }

  status(root: string): ProjectTestMutationCheck | undefined {
    const live = this.checks.get(normalize(root));
    if (!live) return undefined;
    // Итог объявляется после уборки копии: раньше него новая проверка пошла бы
    // поверх недоснятого worktree, а на Windows занятая папка не удаляется.
    return live.cleaning ? { ...live.view, status: 'running', stage: 'cleanup' } : live.view;
  }

  isRunning(root: string): boolean {
    return this.status(root)?.status === 'running';
  }

  /** Проверка идёт в фоне; ответ — её состояние сразу после старта. */
  start(input: MutationStart): ProjectTestMutationCheck {
    const root = normalize(input.root);
    if (this.isRunning(root)) {
      throw Object.assign(failure('A mutation check is already running.', 'mutation-busy'), {
        statusCode: 409,
      });
    }
    const file = input.file.replace(/\\/g, '/').replace(/^\.\//, '').trim();
    const absolute = join(root, file);
    const inside = relative(root, absolute);
    if (!file || isAbsolute(file) || inside.startsWith('..') || inside.split(sep)[0] === '.git') {
      throw failure(`Not a project file: ${file}`, 'mutation-file-invalid', { file });
    }
    // Только обычный файл самого проекта: не ссылка (запись прошла бы по ней в
    // настоящий файл) и не файл зависимостей (они в копии — ссылки на оригинал).
    let isFile = false;
    try {
      isFile = lstatSync(absolute).isFile();
    } catch {
      // Нет файла — отказ ниже.
    }
    const inDependencies = file.split('/').some((part) => DEPENDENCY_DIRS.has(part));
    if (!isFile || inDependencies) {
      throw failure(`Not a project file: ${file}`, 'mutation-file-invalid', { file });
    }
    const cases = casesForFile(root, file);
    if (cases.length === 0) {
      throw failure(`No automated case is linked to ${file}.`, 'mutation-no-cases', { file });
    }
    const mode = input.mode ?? 'break';
    const original = readFileSync(absolute, 'utf8');
    const broken = breakFile(original, file, mode);
    if (!broken) {
      throw failure(`Nothing to flip in ${file}.`, 'mutation-unbreakable', { file });
    }
    const now = input.now ?? (() => new Date().toISOString());
    const view: ProjectTestMutationCheck = {
      status: 'running',
      stage: 'copy',
      file,
      mode,
      mutation: broken.description,
      startedAt: now(),
      log: '',
      cases,
      caught: 0,
      missed: 0,
    };
    const live: Live = { view, links: [] };
    this.checks.set(root, live);
    void this.run(root, input.appData, live, broken.text, now).catch((error: unknown) => {
      this.fail(live, (error as Error).message, 'mutation-failed', now);
    });
    return view;
  }

  stop(root: string): ProjectTestMutationCheck | undefined {
    const live = this.checks.get(normalize(root));
    if (!live || live.view.status !== 'running') return live?.view;
    live.stopped = true;
    live.view.status = 'stopped';
    // Прогон ещё может заводить копию (`git worktree add`) — до его уборки
    // проверка занята: новая пошла бы поверх, а папку под ним не удалить (ревью PR #1).
    live.cleaning = true;
    const child = live.child;
    if (child) {
      killChildTree(child, { group: process.platform !== 'win32' });
      // Команда, пропустившая мягкий сигнал, держала бы проверку и копию вечно.
      setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) {
          try {
            child.kill('SIGKILL');
          } catch {
            // Уже вышла.
          }
        }
      }, KILL_GRACE_MS).unref?.();
    }
    return live.view;
  }

  /** Выход панели: процессы и копии не должны пережить её сиротами. */
  stopAll(): void {
    for (const root of this.checks.keys()) this.stop(root);
  }

  private fail(live: Live, message: string, code: MutationCode, now: () => string): void {
    if (live.view.status !== 'running') return;
    Object.assign(live.view, {
      status: 'error',
      error: message,
      errorCode: code,
      finishedAt: now(),
    });
  }

  private async run(
    root: string,
    appData: string,
    live: Live,
    brokenText: string,
    now: () => string,
  ): Promise<void> {
    const { view } = live;
    const id = randomUUID().slice(0, 8);
    const copy = join(appData, COPIES_DIR, id);
    mkdirSync(dirname(copy), { recursive: true });
    try {
      await git(root, ['worktree', 'add', '--detach', copy, 'HEAD']);
      live.copy = copy;
      // Незакоммиченные правки — поверх: проверяется код, который человек видит.
      // Не легла правка — отказ: иначе проверка шла бы по другому коду, и
      // упавший на импорте кейс читался бы как «поймал».
      const diff = await git(root, ['diff', '--binary', 'HEAD']);
      if (diff.trim()) {
        const patch = join(copy, '.agentdeck-mutation.patch');
        writeFileSync(patch, diff);
        await git(copy, ['apply', '--whitespace=nowarn', patch]);
        rmSync(patch, { force: true });
      }
      // Новые файлы, ещё не добавленные в git, — тоже: без них копия не собиралась бы.
      const untracked = await git(root, ['ls-files', '--others', '--exclude-standard', '-z']);
      for (const path of untracked.split('\0').filter(Boolean)) {
        const from = join(root, path);
        if (!lstatSync(from).isFile()) continue;
        mkdirSync(dirname(join(copy, path)), { recursive: true });
        cpSync(from, join(copy, path));
      }
      for (const dir of dependencyDirs(root)) {
        const target = join(copy, dir);
        if (existsSync(target) || !existsSync(dirname(target))) continue;
        link(live, join(root, dir), target);
      }
      if (live.stopped) return;

      view.stage = 'break';
      // Пишется только обычный файл внутри копии: по ссылке запись ушла бы в оригинал.
      const target = join(copy, view.file);
      const real = realpathSync(target);
      const inside = relative(realpathSync(copy), real);
      if (!lstatSync(target).isFile() || inside.startsWith('..') || isAbsolute(inside)) {
        throw failure(`Not a project file: ${view.file}`, 'mutation-file-invalid', {
          file: view.file,
        });
      }
      writeFileSync(target, brokenText);

      view.stage = 'run';
      const files = [...new Set(view.cases.map((item) => item.automationFile))];
      const report = join(appData, COPIES_DIR, `${id}.junit.xml`);
      const command = this.command(root, copy, appData, files, report, live);
      view.command = command.line;
      // Отчёт по постоянному пути (`automation.report`) мог приехать в копию от
      // прошлого прогона человека: упавшая команда читалась бы его итогом (ревью PR #1).
      rmSync(command.report, { force: true });
      const code = await this.exec(live, command, now);
      if (live.stopped) return;

      view.stage = 'report';
      view.exitCode = code;
      if (!existsSync(command.report)) {
        this.fail(
          live,
          `No report appeared (exit code ${code ?? 'none'}).`,
          'mutation-no-report',
          now,
        );
        return;
      }
      const { points } = prepareResultsForRun(
        root,
        { format: 'junit', content: readFileSync(command.report, 'utf8'), now: now() },
        id,
      );
      for (const item of view.cases) {
        const point = points.find(
          (result) => result.groupId === item.groupId && result.caseId === item.caseId,
        );
        if (point) item.status = point.status;
      }
      view.caught = view.cases.filter(
        (item) => item.status === 'failed' || item.status === 'blocked',
      ).length;
      view.missed = view.cases.filter((item) => item.status === 'passed').length;
      view.status = 'done';
      view.finishedAt = now();
      rmSync(command.report, { force: true });
    } catch (error) {
      // Причина — до уборки: иначе finally подменил бы её на «отчёта нет».
      const code = (error as { messageCode?: string }).messageCode;
      this.fail(
        live,
        (error as Error).message,
        code?.startsWith('mutation-') ? (code as MutationCode) : 'mutation-failed',
        now,
      );
    } finally {
      view.stage = view.status === 'running' ? 'cleanup' : view.stage;
      live.cleaning = true;
      try {
        await dropCopy(root, copy, live.links);
      } finally {
        live.cleaning = false;
      }
      rmSync(join(appData, COPIES_DIR, `${id}.junit.xml`), { force: true });
      if (view.status === 'running') {
        this.fail(live, 'The check ended without a report.', 'mutation-no-report', now);
      }
      if (!view.finishedAt) view.finishedAt = now();
    }
  }

  /** Та же команда, что гоняет автотесты раздела, — но в копии. */
  private command(
    root: string,
    copy: string,
    appData: string,
    files: string[],
    report: string,
    live: Live,
  ): { line: string; cwd: string; env: Record<string, string>; report: string; timeout: number } {
    const folder = e2eFolderView(root, appData);
    const prefix = folder.dir ? `${folder.dir.replace(/\/+$/, '')}/` : '';
    const inFolder = prefix !== '' && files.every((file) => file.startsWith(prefix));
    const { automation } = readAutomation(root);
    if (folder.state !== 'missing' && folder.dir && (!automation || inFolder)) {
      // Папка, спрятанная от git (её завела панель), в копию не приезжает сама.
      // Копией, а не ссылкой: по ссылке импорты тестов разрешались бы в оригинал,
      // и поломка копии была бы им не видна. Зависимости папки — ссылкой.
      const dir = join(copy, folder.dir);
      const source = join(root, folder.dir);
      if (!existsSync(dir) && existsSync(source)) {
        cpSync(source, dir, {
          recursive: true,
          filter: (path) => !path.split(/[\\/]/).some((part) => DEPENDENCY_DIRS.has(part)),
        });
        for (const deps of dependencyDirs(source)) link(live, join(source, deps), join(dir, deps));
      }
      const command = e2eCommand(copy, folder, report, files);
      if (command) {
        return { ...command, env: command.env ?? {}, report, timeout: DEFAULT_TIMEOUT_MINUTES };
      }
    }
    if (automation) {
      const own = automationCommand(copy, automation, files, report);
      return {
        line: own.line,
        cwd: own.cwd,
        env: own.env,
        report: own.report,
        timeout: automation.timeoutMinutes ?? DEFAULT_TIMEOUT_MINUTES,
      };
    }
    throw failure('The project has no command to run its automated cases.', 'mutation-no-command');
  }

  private exec(
    live: Live,
    command: { line: string; cwd: string; env: Record<string, string>; timeout: number },
    now: () => string,
  ): Promise<number | null> {
    return new Promise((done) => {
      const append = (chunk: Buffer | string): void => {
        live.view.log = `${live.view.log}${chunk.toString()}`.slice(-LOG_LIMIT);
      };
      let child: ChildProcess;
      try {
        child = this.spawnImpl(command.line, command.cwd, { ...process.env, ...command.env });
      } catch (error) {
        this.fail(live, (error as Error).message, 'mutation-spawn', now);
        done(null);
        return;
      }
      live.child = child;
      child.stdout?.on('data', append);
      child.stderr?.on('data', append);
      child.on('error', (error) => append(`\n${error.message}\n`));
      live.timer = setTimeout(() => {
        append(`\nstopped after ${command.timeout} min\n`);
        killChildTree(child, { group: process.platform !== 'win32' });
      }, command.timeout * 60_000);
      live.timer.unref?.();
      let settled = false;
      const settle = (code: number | null): void => {
        if (settled) return;
        settled = true;
        live.child = undefined;
        if (live.timer) clearTimeout(live.timer);
        done(code);
      };
      // Помощник команды (dev-сервер, наблюдатель), унаследовавший её вывод, держит
      // `close` до своего конца — проверка висела бы после выхода самой команды
      // (ревью PR #1). По выходу — короткий дочит вывода, и итог.
      child.on('exit', (code) => {
        setTimeout(() => {
          child.stdout?.destroy();
          child.stderr?.destroy();
          settle(code);
        }, EXIT_DRAIN_MS).unref?.();
      });
      child.on('close', (code) => settle(code));
    });
  }
}
