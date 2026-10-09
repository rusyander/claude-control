import { spawn, type ChildProcess } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type {
  ProjectTestE2eRun,
  ProjectTestEnvironment,
  ProjectTestRunRecord,
} from '@agentdeck/contracts';
import { summarize } from '@agentdeck/contracts/test-format';
import { killChildTree } from '../../../lib/process-tree/process-tree.ts';
import { PanelAgentProcesses } from '../../panel-agent/processes/processes.ts';
import { coded } from '../../../lib/server-text/server-text.ts';
import { forgetOtherSpellings, ProjectTestsError, projectEntry } from '../files.ts';
import { redactor } from '../env-secrets/env-secrets.ts';
import { e2eFolderView } from '../e2e-folder/e2e-folder.ts';
import { automationCommand, readAutomation } from '../automation/automation.ts';
import { readGroups } from '../store/store.ts';
import { gitContext } from '../impact/impact.ts';
import { prepareResultsForRun } from '../import-results/import-results.ts';
import { readEnvironments } from '../library/library.ts';
import {
  E2E_RUN_PROCESS_LEDGER,
  pickEnvironmentId,
  type RunSecretsResolver,
} from '../runs/runs.ts';
import { writeRun } from '../runs-store/runs-store.ts';
import {
  e2eCommand,
  installedBin,
  BROWSER_MISSING,
  NOT_INSTALLED,
  runDirOf,
  type E2eCommand,
} from '../e2e-command/e2e-command.ts';

export {
  e2eCommand,
  installedBin,
  shellLine,
  type E2eCommand,
} from '../e2e-command/e2e-command.ts';

/**
 * «Прогнать автотесты»: команда каркаса папки e2e, запущенная самой панелью, —
 * без агента и без токенов. Отчёт каркаса junit пишется В КАТАЛОГ ПАНЕЛИ, а не в
 * проект (в git ничего не ложится); исключение — своя команда проекта
 * (`automation.json`) с путём `report`: там отчёт в проекте, и перед каждым
 * прогоном он стирается. Результаты становятся одной записью истории прогонов.
 *
 * Код выхода не равен итогу: красные тесты — ненулевой код, и это результат, а
 * не сбой. Сбой — когда отчёта нет: команда не нашлась или упала до тестов.
 */

const LOG_LIMIT = 16_000;

/** Отказ «раннер не установлен» словами и кодом: где и что выполнить. */
function notInstalled(
  root: string,
  command: Pick<E2eCommand, 'cwd' | 'install'> | undefined,
): ProjectTestsError & { params: { dir: string; install: string } } {
  const dir = runDirOf(root, command);
  const install = command?.install ?? '';
  const where = dir === '.' ? 'в корне проекта' : `в ${dir}`;
  const error = coded(
    new ProjectTestsError(
      `Раннер автотестов не установлен, а сама панель его не ставит. Выполните ${where}: ${install}`,
    ),
    'e2e-run-not-installed',
    { dir, install },
  );
  return error as typeof error & { params: { dir: string; install: string } };
}

/** Переменные адреса стенда: у каждого каркаса своё имя, значение одно. */
export function standEnv(environment: ProjectTestEnvironment | undefined): Record<string, string> {
  const url = environment?.baseUrl?.trim();
  if (!url) return {};
  return { E2E_BASE_URL: url, CYPRESS_BASE_URL: url, PYTEST_BASE_URL: url };
}

/** Отчёт прогона — в каталоге панели, по проекту: соседние проекты не путаются. */
export function e2eReportPath(appData: string, root: string): string {
  const key = createHash('sha256').update(root.toLowerCase()).digest('hex').slice(0, 16);
  return join(appData, 'e2e-runs', key, 'junit.xml');
}

export interface E2eRunStart {
  root: string;
  appData: string;
  environmentId?: string;
  /** Только кейсы этой группы — их `automation.file`. */
  groupId?: string;
  /** Только эти кейсы (внутри `groupId`, если он задан). */
  caseIds?: string[];
  secrets?: RunSecretsResolver;
  now?: () => string;
}

type Spawner = (line: string, cwd: string, env: NodeJS.ProcessEnv) => ChildProcess;

const defaultSpawn: Spawner = (line, cwd, env) =>
  spawn(line, {
    cwd,
    env,
    shell: true,
    windowsHide: true,
    detached: process.platform !== 'win32',
  });

export { E2E_RUN_PROCESS_LEDGER } from '../runs/runs.ts';

interface Live {
  view: ProjectTestE2eRun;
  child?: ChildProcess;
  /** Запись процесса в журнале: снимается на закрытии раннера. */
  processes?: { ledger: PanelAgentProcesses; key: string };
  timer?: NodeJS.Timeout;
  /** Остановлен потолком `timeoutMinutes`, а не человеком. */
  timedOut?: boolean;
}

/** Чем гонять: командой папки e2e или своей командой проекта (automation.json). */
interface RunPlan {
  line: string;
  cwd: string;
  env: Record<string, string>;
  report: string;
  /** Подпись записи истории: чья команда шла. */
  scope: string;
  timeoutMinutes?: number;
  folder?: E2eCommand;
}

/**
 * Файлы выбранных кейсов (`automation.file`, без повторов). `undefined` — выбора
 * не было, гонится весь набор; пустой список при выборе — отказ: гнать нечего.
 */
function selectedFiles(root: string, groupId?: string, caseIds?: string[]): string[] | undefined {
  if (!groupId && !(caseIds && caseIds.length > 0)) return undefined;
  return automatedFiles(root, groupId, caseIds);
}

/** `automation.file` живых кейсов (группы, кейсов — если заданы), без повторов. */
function automatedFiles(root: string, groupId?: string, caseIds?: string[]): string[] {
  const wanted = new Set(caseIds ?? []);
  const files = readGroups(root)
    .filter((group) => !groupId || group.id === groupId)
    .flatMap((group) => group.cases)
    .filter((item) => !item.archived && (wanted.size === 0 || wanted.has(item.id)))
    .map((item) => item.automation?.file)
    .filter((file): file is string => Boolean(file));
  return [...new Set(files)];
}

/** Один прогон автотестов на проект; последний итог держится до следующего. */
export class E2eRunRegistry {
  private readonly runs = new Map<string, Live>();
  /** Команда последнего прогона проекта — для подсказки «что поставить». */
  private readonly commands = new Map<string, E2eCommand>();
  /** Подпись записи истории последнего прогона проекта. */
  private readonly scopes = new Map<string, string>();
  private readonly spawnImpl: Spawner;

  constructor(spawnImpl: Spawner = defaultSpawn) {
    this.spawnImpl = spawnImpl;
  }

  get(root: string): ProjectTestE2eRun | undefined {
    return projectEntry(this.runs, root)?.view;
  }

  /**
   * Прогон держит проект, пока не ЗАКРЫТ: остановленный раннер ещё умирает, а
   * на закрытии итог ложится в файлы групп. По статусу «идёт» в этом окне уже
   * можно было стартовать агента или второй прогон — и закрытие первого писало
   * бы поверх них (второй ещё и прочёл бы чужой отчёт).
   */
  isRunning(root: string): boolean {
    const live = projectEntry(this.runs, root);
    return live !== undefined && live.view.finishedAt === undefined;
  }

  /** Проекты, где автотесты идут сейчас, — наблюдатель папки ждёт их конца. */
  runningRoots(): string[] {
    return [...this.runs.entries()]
      .filter(([, live]) => live.view.status === 'running')
      .map(([root]) => root);
  }

  /**
   * Погасить все идущие прогоны — выход панели. Раннер запущен через оболочку
   * и сам с панелью не умирает: браузеры Playwright оставались бы сиротами.
   */
  stopAll(): void {
    for (const root of this.runningRoots()) this.stop(root);
  }

  start(input: E2eRunStart): ProjectTestE2eRun {
    const { root, appData } = input;
    if (this.isRunning(root)) {
      // Конфликт, а не плохая заявка: 409, как у прогона агента.
      throw coded(
        Object.assign(new ProjectTestsError('Автотесты уже идут.'), { statusCode: 409 }),
        'e2e-run-busy',
      );
    }
    const plan = this.plan(root, appData, selectedFiles(root, input.groupId, input.caseIds));
    const { report } = plan;
    const now = input.now ?? (() => new Date().toISOString());
    const environments = readEnvironments(root);
    const environmentId = pickEnvironmentId(environments, input.environmentId);
    const environment = environments.find((item) => item.id === environmentId);
    const secrets = input.secrets?.(environment) ?? { values: {}, missing: [] };
    const hide = redactor(secrets.values) ?? ((text: string) => text);

    // Прошлый отчёт — долой ДО запуска: иначе упавшая команда «вернула» бы
    // вчерашние результаты.
    rmSync(report, { force: true });
    mkdirSync(join(report, '..'), { recursive: true });

    if (plan.folder) this.commands.set(root, plan.folder);
    else this.commands.delete(root);
    this.scopes.set(root, plan.scope);
    const view: ProjectTestE2eRun = {
      status: 'running',
      command: plan.line,
      startedAt: now(),
      log: '',
    };
    const live: Live = { view };
    forgetOtherSpellings(this.runs, root);
    this.runs.set(root, live);

    let child: ChildProcess;
    try {
      child = this.spawnImpl(plan.line, plan.cwd, {
        ...process.env,
        ...secrets.values,
        ...standEnv(environment),
        ...plan.env,
      });
    } catch (error) {
      view.status = 'error';
      view.finishedAt = now();
      view.error = (error as Error).message;
      view.errorCode = 'e2e-run-spawn';
      return view;
    }
    live.child = child;
    if (child.pid) {
      const ledger = new PanelAgentProcesses(() => appData, undefined, E2E_RUN_PROCESS_LEDGER);
      const key = `e2e:${randomUUID()}`;
      ledger.started(key, child.pid, root);
      live.processes = { ledger, key };
    }
    const append = (chunk: Buffer | string): void => {
      view.log = hide(`${view.log}${chunk.toString()}`).slice(-LOG_LIMIT);
    };
    child.stdout?.on('data', append);
    child.stderr?.on('data', append);
    child.on('error', (error) => {
      append(`\n${error.message}\n`);
    });
    child.on('close', (code) => {
      live.child = undefined;
      live.processes?.ledger.exited(live.processes.key);
      if (live.timer) clearTimeout(live.timer);
      this.finish(root, view, code, report, environmentId, now(), live.timedOut === true);
    });
    // Потолок из automation.json: зависший прогон держал бы кнопку и замок вечно.
    if (plan.timeoutMinutes) {
      live.timer = setTimeout(() => {
        append(`\nПрогон дольше ${plan.timeoutMinutes} мин — остановлен.\n`);
        live.timedOut = true;
        this.stop(root);
      }, plan.timeoutMinutes * 60_000);
      live.timer.unref?.();
    }
    return view;
  }

  /**
   * Чем гонять. Папка e2e с тестами и узнанным каркасом — её командой (и только
   * она, если выбранные файлы лежат в ней); иначе — своей командой проекта из
   * `automation.json`. Нет ни того, ни другого — прежние отказы словами.
   */
  private plan(root: string, appData: string, files: string[] | undefined): RunPlan {
    if (files && files.length === 0) {
      throw coded(
        new ProjectTestsError(
          'У выбранных кейсов нет автотеста (automation.file) — прогонять нечего.',
        ),
        'e2e-run-nothing-selected',
      );
    }
    const report = e2eReportPath(appData, root);
    const folder = e2eFolderView(root, appData);
    const prefix = folder.dir ? `${folder.dir.replace(/\/+$/, '')}/` : '';
    const inFolder = !files || (prefix !== '' && files.every((file) => file.startsWith(prefix)));
    const command =
      folder.state !== 'missing' ? e2eCommand(root, folder, report, files) : undefined;
    const { automation } = readAutomation(root);
    if (command && (!automation || (inFolder && folder.specs > 0))) {
      if (command.bin && !installedBin(command.cwd, command.bin)) throw notInstalled(root, command);
      return { ...command, report, scope: `Автотесты папки e2e: ${command.line}`, folder: command };
    }
    if (automation) {
      // Без выбора `{files}` — файлы ВСЕХ кейсов с автотестом: запускателю вроде
      // junit-run «весь набор» без списка неоткуда взять.
      const own = automationCommand(root, automation, files ?? automatedFiles(root), report);
      return {
        ...own,
        scope: `Автотесты проекта: ${own.line}`,
        ...(automation.timeoutMinutes ? { timeoutMinutes: automation.timeoutMinutes } : {}),
      };
    }
    if (folder.state === 'missing') {
      throw coded(new ProjectTestsError('Папки e2e в проекте нет.'), 'e2e-missing');
    }
    throw coded(
      new ProjectTestsError('Каркас папки e2e не распознан — команду прогона не угадать.'),
      'e2e-run-unknown-framework',
    );
  }

  stop(root: string): ProjectTestE2eRun | undefined {
    const live = projectEntry(this.runs, root);
    if (!live || live.view.status !== 'running') return live?.view;
    live.view.status = 'stopped';
    // Дерево — пока процесс жив: вышедший мог отдать номер чужому (`killChildTree`).
    if (live.child) killChildTree(live.child, { group: process.platform !== 'win32' });
    return live.view;
  }

  private finish(
    root: string,
    view: ProjectTestE2eRun,
    code: number | null,
    report: string,
    environmentId: string | undefined,
    at: string,
    timedOut = false,
  ): void {
    const stopped = view.status === 'stopped';
    view.exitCode = code;
    view.finishedAt = at;
    let fresh = false;
    try {
      fresh = statSync(report).mtimeMs >= Date.parse(view.startedAt) - 1000;
    } catch {
      // Отчёта нет.
    }
    const runId = randomUUID();
    const base: Omit<ProjectTestRunRecord, 'status' | 'results' | 'summary'> = {
      id: runId,
      mode: 'import',
      actor: 'ci',
      // Не отчёт сборки, а прогон панели: история подписывает его «автотесты».
      origin: 'e2e',
      environmentId,
      ...gitContext(root),
      scope: this.scopes.get(root) ?? `Автотесты папки e2e: ${view.command}`,
      ...(typeof code === 'number' ? { exitCode: code } : {}),
      startedAt: view.startedAt,
      finishedAt: at,
    };
    // Браузер раннера не скачан: свежий отчёт красный целиком, но кейсы не трогаем и
    // историю не пишем — иначе вся библиотека краснеет из-за окружения.
    const browserMissing = !stopped && BROWSER_MISSING.test(view.log);
    if (!fresh || browserMissing) {
      if (browserMissing || (!stopped && NOT_INSTALLED.test(view.log))) {
        const refusal = notInstalled(root, this.commands.get(root));
        Object.assign(view, {
          status: 'error',
          error: refusal.message,
          errorCode: 'e2e-run-not-installed',
          errorParams: refusal.params,
        });
      } else if (!stopped) {
        Object.assign(view, {
          status: 'error',
          error: `Отчёт не появился (код выхода ${code ?? 'нет'}) — смотрите вывод команды.`,
          errorCode: 'e2e-run-no-report',
        });
      } else if (timedOut) {
        // Остановка потолком — след в истории, а не одна строка журнала: иначе
        // зависший прогон исчезал бесследно, будто его не было.
        const results: ProjectTestRunRecord['results'] = [];
        writeRun(root, {
          ...base,
          status: 'stopped',
          results,
          summary: summarize(results),
          error: 'Прогон превысил timeoutMinutes и остановлен до отчёта.',
          messageCode: 'e2e-run-timeout',
        });
        view.runId = runId;
      }
      return;
    }
    try {
      const { result, points, apply } = prepareResultsForRun(
        root,
        { format: 'junit', content: readFileSync(report, 'utf8'), environmentId, now: at },
        runId,
      );
      const summary = summarize(points);
      writeRun(root, {
        ...base,
        status: stopped ? 'stopped' : 'done',
        results: points,
        summary,
      });
      // Статусы — ПОСЛЕ записи прогона: иначе сбой записи оставил бы кейсы со
      // ссылкой на прогон, которого нет в истории.
      const matched = apply();
      view.runId = runId;
      view.imported = {
        read: result.read,
        matched,
        unmatched: result.unmatched.length,
      };
      view.summary = summary;
      if (result.unmatched.length > 0) view.unmatchedNames = result.unmatched.slice(0, 5);
      if (!stopped) view.status = 'done';
    } catch (error) {
      view.status = 'error';
      view.error = (error as Error).message;
      view.errorCode = 'e2e-run-import';
    }
  }
}
