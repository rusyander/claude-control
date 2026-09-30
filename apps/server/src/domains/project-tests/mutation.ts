import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
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
  timer?: NodeJS.Timeout;
  stopped?: boolean;
}

export class MutationChecks {
  private readonly checks = new Map<string, Live>();
  private readonly spawnImpl: Spawner;

  constructor(spawnImpl: Spawner = defaultSpawn) {
    this.spawnImpl = spawnImpl;
  }

  status(root: string): ProjectTestMutationCheck | undefined {
    return this.checks.get(normalize(root))?.view;
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
    let isFile = false;
    try {
      isFile = statSync(absolute).isFile();
    } catch {
      // Нет файла — отказ ниже.
    }
    if (!isFile) throw failure(`Not a project file: ${file}`, 'mutation-file-invalid', { file });
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
    const live: Live = { view };
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
    if (live.child) killChildTree(live.child, { group: process.platform !== 'win32' });
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
    const copy = join(appData, 'mutation-copies', id);
    mkdirSync(dirname(copy), { recursive: true });
    try {
      await git(root, ['worktree', 'add', '--detach', copy, 'HEAD']);
      live.copy = copy;
      // Незакоммиченные правки — поверх: проверяется код, который человек видит.
      const diff = await git(root, ['diff', '--binary', 'HEAD']).catch(() => '');
      if (diff.trim()) {
        const patch = join(copy, '.agentdeck-mutation.patch');
        writeFileSync(patch, diff);
        await git(copy, ['apply', '--whitespace=nowarn', patch]).catch(() => '');
        rmSync(patch, { force: true });
      }
      for (const dir of dependencyDirs(root)) {
        const target = join(copy, dir);
        if (existsSync(target) || !existsSync(dirname(target))) continue;
        symlinkSync(join(root, dir), target, process.platform === 'win32' ? 'junction' : 'dir');
      }
      if (live.stopped) return;

      view.stage = 'break';
      writeFileSync(join(copy, view.file), brokenText);

      view.stage = 'run';
      const files = [...new Set(view.cases.map((item) => item.automationFile))];
      const report = join(appData, 'mutation-copies', `${id}.junit.xml`);
      const command = this.command(root, copy, appData, files, report);
      view.command = command.line;
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
    } finally {
      view.stage = view.status === 'running' ? 'cleanup' : view.stage;
      if (live.copy) {
        await git(root, ['worktree', 'remove', '--force', live.copy]).catch(() => '');
      }
      rmSync(copy, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
      await git(root, ['worktree', 'prune']).catch(() => '');
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
  ): { line: string; cwd: string; env: Record<string, string>; report: string; timeout: number } {
    const folder = e2eFolderView(root, appData);
    const prefix = folder.dir ? `${folder.dir.replace(/\/+$/, '')}/` : '';
    const inFolder = prefix !== '' && files.every((file) => file.startsWith(prefix));
    const { automation } = readAutomation(root);
    if (folder.state !== 'missing' && folder.dir && (!automation || inFolder)) {
      // Папка, спрятанная от git (её завела панель), в копию не приезжает — ссылкой.
      const dir = join(copy, folder.dir);
      if (!existsSync(dir) && existsSync(join(root, folder.dir))) {
        mkdirSync(dirname(dir), { recursive: true });
        symlinkSync(join(root, folder.dir), dir, process.platform === 'win32' ? 'junction' : 'dir');
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
      child.on('close', (code) => {
        live.child = undefined;
        if (live.timer) clearTimeout(live.timer);
        done(code);
      });
    });
  }
}
