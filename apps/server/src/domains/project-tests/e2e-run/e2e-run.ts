import { spawn, type ChildProcess } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type {
  ProjectTestAutomationFormat,
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
import {
  automationCommand,
  clearReport,
  collectReport,
  readAutomation,
  reportTail,
  RUN_FILES_ENV,
} from '../automation/automation.ts';
import { BUILD_FAILURE } from '../automation/native-reports.ts';
import type { ImportedTestResult } from '../import-results/import-results.ts';
import { readGroups } from '../store/store.ts';
import { contentStamps, stampInputs, stampsOf } from '../content-stamp/content-stamp.ts';
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
  // На Linux проекты `App` и `app` — разные: общий отчёт путал бы их прогоны.
  const spelled = process.platform === 'win32' ? root.toLowerCase() : root;
  const key = createHash('sha256').update(spelled).digest('hex').slice(0, 16);
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
  /** Тесты прогона без кейса — целиком: из них «Завести кейсы» делает кейсы. */
  unmatched?: ImportedTestResult[];
  /** Отпечатки содержимого кейсов на старте (`content-stamp`) — в запись истории. */
  stamps?: Map<string, string>;
}

/** Отпечатки кейсов, которые прогон может прогнать: выбранных, иначе всех с автотестом. */
function startStamps(root: string, groupId?: string, caseIds?: string[]): Map<string, string> {
  const wanted = new Set(caseIds ?? []);
  const groups = readGroups(root).filter((group) => !groupId || group.id === groupId);
  const keys = new Set(
    groups.flatMap((group) =>
      group.cases
        .filter((item) => item.automation?.file && (wanted.size === 0 || wanted.has(item.id)))
        .map((item) => `${group.id}:${item.id}`),
    ),
  );
  return contentStamps(root, stampInputs(groups, keys));
}

/** Чем гонять: командой папки e2e или своей командой проекта (automation.json). */
interface RunPlan {
  line: string;
  cwd: string;
  env: Record<string, string>;
  report: string;
  /** Вид отчёта; у команды папки — всегда JUnit. */
  format?: ProjectTestAutomationFormat;
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

    // Прошлый файл отчёта — долой ДО запуска; каталог отчётов (Gradle, Maven)
    // остаётся, вчерашнее в нём отсекается временем записи.
    clearReport(report);

    if (plan.folder) this.commands.set(root, plan.folder);
    else this.commands.delete(root);
    this.scopes.set(root, plan.scope);
    const view: ProjectTestE2eRun = {
      status: 'running',
      command: plan.line,
      startedAt: now(),
      log: '',
    };
    // До запуска раннера: отпечаток — то, что прогон увидит, а не то, что лежит после.
    const live: Live = { view, stamps: startStamps(root, input.groupId, input.caseIds) };
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
      this.finish(
        live,
        root,
        code,
        { path: report, format: plan.format ?? 'junit', own: !plan.folder },
        environmentId,
        now(),
      );
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
      // junit-run «весь набор» без списка неоткуда взять; `{paths}`/`{packages}`
      // — весь набор раннера (см. automationCommand).
      const own = automationCommand(
        root,
        automation,
        files ?? automatedFiles(root),
        report,
        files === undefined,
      );
      return {
        ...own,
        // Список, не влезший в строку, назван знаками: число путей и переменная.
        scope: `Автотесты проекта: ${own.line}${own.listed ? ` [${own.listed} → ${RUN_FILES_ENV}]` : ''}`,
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

  /**
   * Тесты последнего прогона без кейса — забрать один раз: после «Завести
   * кейсы» кнопка гаснет, второе нажатие завело бы те же кейсы повторно.
   */
  takeUnmatched(root: string): ImportedTestResult[] {
    const live = projectEntry(this.runs, root);
    if (!live || live.view.status === 'running') return [];
    const taken = live.unmatched ?? [];
    live.unmatched = undefined;
    delete live.view.adoptable;
    return taken;
  }

  /** Сколько кейсов завела «Завести кейсы» из последнего прогона — итог перестаёт звать их «без кейса». */
  markAdopted(root: string, count: number): void {
    const live = projectEntry(this.runs, root);
    if (live && count > 0) live.view.adopted = (live.view.adopted ?? 0) + count;
  }

  /** Вернуть забранное, если завести кейсы не вышло: кнопка не должна пропасть зря. */
  restoreUnmatched(root: string, results: ImportedTestResult[]): void {
    const live = projectEntry(this.runs, root);
    if (!live || results.length === 0) return;
    live.unmatched = results;
    live.view.adoptable = results.length;
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
    live: Live,
    root: string,
    code: number | null,
    report: { path: string; format: ProjectTestAutomationFormat; own: boolean },
    environmentId: string | undefined,
    at: string,
  ): void {
    const { view } = live;
    const timedOut = live.timedOut === true;
    const stopped = view.status === 'stopped';
    view.exitCode = code;
    view.finishedAt = at;
    const collected = collectReport(report.path, report.format, Date.parse(view.startedAt));
    const fresh = collected !== undefined;
    if (!fresh && report.format !== 'junit') {
      // Родной вывод шёл в файл: без его хвоста причина («cargo не найден»)
      // не видна нигде — вывод команды пуст.
      const tail = reportTail(report.path);
      if (tail) view.log = `${view.log}\n${tail}\n`.slice(-LOG_LIMIT);
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
      const { result, points, apply, unmatchedResults } = prepareResultsForRun(
        root,
        { format: 'junit', content: collected.content, environmentId, now: at },
        runId,
      );
      const summary = summarize(points);
      writeRun(root, {
        ...base,
        status: stopped ? 'stopped' : 'done',
        ...stampsOf(live.stamps, points),
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
      // Имена — только тестов: «(build)» итог называет своей строкой (`buildFailed`).
      const names = result.unmatched.filter((name) => name !== BUILD_FAILURE);
      if (names.length > 0) view.unmatchedNames = names.slice(0, 5);
      // «Завести кейсы» — только у своей команды: тесты папки e2e заводит
      // «Обновить из папки», и она читает из спека ещё и шаги. «(build)» —
      // сборка пакета, а не тест: кейсом не станет и в счёт кнопки не входит,
      // иначе «Завести кейсы (7)» завела бы шесть.
      live.unmatched = report.own
        ? unmatchedResults.filter((item) => item.name !== BUILD_FAILURE)
        : undefined;
      if (live.unmatched?.length) view.adoptable = live.unmatched.length;
      if (report.own) view.own = true;
      const buildFailed = unmatchedResults.filter((item) => item.name === BUILD_FAILURE).length;
      if (buildFailed > 0) view.buildFailed = buildFailed;
      if (!stopped) view.status = 'done';
    } catch (error) {
      view.status = 'error';
      view.error = (error as Error).message;
      view.errorCode = 'e2e-run-import';
    }
  }
}
