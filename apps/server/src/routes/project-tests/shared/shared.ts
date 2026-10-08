import { resolve } from 'node:path';
import type { ProjectTestAutomationCommand, ProjectTestsView } from '@agentdeck/contracts';
import type { FastifyReply } from 'fastify';
import type { ServerContext } from '../../../context.ts';
import { checkProjectDir } from '../../../domains/projects/projects.ts';
import { spelledOnDisk } from '../../../lib/disk-spelling/disk-spelling.ts';
import {
  type E2eRunRegistry,
  type E2eWatch,
  type MutationChecks,
  ProjectTestManualRegistry,
  ProjectTestRunRegistry,
  ProjectTestsError,
  ProjectTestsLockedError,
  ProjectTestsNotFoundError,
  TESTS_DIR,
  assertProjectOrCopy,
  isProjectOrCopy,
  e2eFolderView,
  hasConvention,
  readDraftSummaries,
  readEnvironments,
  readGroups,
  readLibraryIssues,
  readAutomation,
  readPlans,
  readRuns,
  readSchema,
  readSharedSteps,
  readViews,
  repairFutureStamps,
  settleOrphanRuns,
  viewGitContext,
} from '../../../domains/project-tests/project-tests.ts';
import { codeOf, coded } from '../../../lib/server-text/server-text.ts';

/**
 * Общее для всех маршрутов раздела тестов: проверка каталога, перевод ошибок
 * домена в ответы и сборка полного вида.
 *
 * Каталог приходит путём, как у файлов и git проекта: вкладку открывают на любой
 * папке, и в реестре проектов её может не быть вовсе. Исключение — то, что пишет
 * в чужое дерево и исполняет его команду (`assertOwnProject`).
 *
 * Вид собирается ЦЕЛИКОМ на каждый ответ, а не по кусочкам: файлов в
 * `.agent/tests/` десятки, но все маленькие, и любая правка кейса может задеть
 * план, вид или общий шаг. Частичные ответы означали бы, что клиент дособирает
 * состояние из нескольких запросов и видит его несогласованным.
 */

/** Всё, что маршрутам раздела нужно сверх самого запроса. */
export interface TestsDeps {
  ctx: ServerContext;
  runs: ProjectTestRunRegistry;
  manual: ProjectTestManualRegistry;
  /** Прогоны автотестов папки e2e самой панелью (без агента). */
  e2eRuns?: E2eRunRegistry;
  /** Наблюдение за папкой e2e: заведённую или убранную папку перечитать сразу. */
  e2eWatch?: E2eWatch;
  /** Проверки набора поломкой — по кнопке человека, одна на проект. */
  mutations?: MutationChecks;
}

/**
 * Каталог проекта из запроса. Ответ уже отправлен, если путь не годится.
 *
 * Путь приводится к написанию на диске: реестры прогонов и ручных сессий
 * держат проект ключом, а Windows не различает `C:\work` и `c:/work`. Веб шлёт путь
 * из реестра, агент панели и терминал — как написали, и по ключу «как пришло»
 * проход, начатый одним, другой не видел, а замок группы не срабатывал.
 */
export function requireRoot(path: unknown, reply: FastifyReply): string | undefined {
  const problem = checkProjectDir(String(path ?? ''));
  if (problem) {
    void reply.code(400).send({ message: problem });
    return undefined;
  }
  return spelledOnDisk(resolve(String(path)));
}

/**
 * Ошибка домена — это ответ с человеческим текстом, а не падение маршрута.
 *
 * Код берём у самой ошибки (`statusCode`): кроме 400 и 404 раздел отвечает 409
 * («группу держит прогон») и 501 («на этой машине нечем напечатать PDF»), и
 * сводить их к 400 значило бы заставить клиента разбирать текст сообщения.
 */
function fail(reply: FastifyReply, error: ProjectTestsError): FastifyReply {
  const status = error.statusCode || (error instanceof ProjectTestsNotFoundError ? 404 : 400);
  const locked = error instanceof ProjectTestsLockedError ? { runId: error.runId } : {};
  return reply.code(status).send({ message: error.message, ...codeOf(error), ...locked });
}

export function guard<T>(reply: FastifyReply, action: () => T): T | FastifyReply {
  try {
    return action();
  } catch (error) {
    if (error instanceof ProjectTestsError) return fail(reply, error);
    throw error;
  }
}

/** То же для асинхронных маршрутов — печать PDF ждёт браузер. */
export async function guardAsync<T>(
  reply: FastifyReply,
  action: () => Promise<T>,
): Promise<T | FastifyReply> {
  try {
    return await action();
  } catch (error) {
    if (error instanceof ProjectTestsError) return fail(reply, error);
    throw error;
  }
}

/**
 * Группу правит один: пока по ней идёт прогон, панель к её файлу не подходит.
 *
 * Агент переписывает файл после каждого кейса, и правка из панели в этот момент
 * либо потеряется, либо сотрёт его результаты. Отказ называет прогон — человек
 * видит его в панели и может остановить.
 */
export function assertUnlocked(deps: TestsDeps, root: string, groupId?: string): void {
  const runId = deps.runs.holds(root, groupId);
  if (!runId) return;
  throw coded(
    new ProjectTestsLockedError(
      `По этой группе идёт прогон (${runId}) — он пишет в тот же файл. Дождись конца или останови его.`,
      runId,
    ),
    'group-run-in-progress',
    { runId },
  );
}

/**
 * Обратная сторона замка автотестов: пока они идут (и пока остановленные ещё
 * закрываются), на закрытии они пишут результаты в файлы групп и гоняют спеки
 * папки. Агент раздела поверх них потерял бы чью-то правку, а уборка папки
 * стёрла бы спеки из-под раннера. Прежде отказывала только одна сторона.
 */
export function assertNoE2eRun(deps: TestsDeps, root: string): void {
  if (!deps.e2eRuns?.isRunning(root)) return;
  throw coded(
    Object.assign(new ProjectTestsError('Автотесты уже идут.'), { statusCode: 409 }),
    'e2e-run-busy',
  );
}

/**
 * Проверка поломкой и автотесты проекта — по одной за раз (Ф11): обе гоняют
 * тот же набор и тот же стенд, и вместе они делили бы порт dev-сервера, отчёт
 * и данные стенда — итог одной читался бы по чужим падениям.
 */
export function assertNoMutationCheck(deps: TestsDeps, root: string): void {
  if (!deps.mutations?.isRunning(root)) return;
  throw coded(
    Object.assign(new ProjectTestsError('Идёт проверка поломкой.'), { statusCode: 409 }),
    'e2e-run-mutation-running',
  );
}

export function assertNoE2eForMutation(deps: TestsDeps, root: string): void {
  if (!deps.e2eRuns?.isRunning(root)) return;
  throw coded(
    Object.assign(new ProjectTestsError('Автотесты проекта уже идут.'), { statusCode: 409 }),
    'mutation-e2e-running',
  );
}

/**
 * Папку e2e заводят и автотесты гоняют только у проектов реестра и копий их
 * веток: это запись в чужое дерево и запуск его команды. Остальной
 * раздел по-прежнему открывается на любом каталоге.
 */
export function assertOwnProject(deps: TestsDeps, root: string): void {
  assertProjectOrCopy(root, projectPaths(deps));
}

/** То же вопросом — там, где чужой каталог не отказ, а работа без папки e2e. */
export function isOwnProject(deps: TestsDeps, root: string): boolean {
  return isProjectOrCopy(root, projectPaths(deps));
}

function projectPaths(deps: TestsDeps): string[] {
  return deps.ctx.store.getProjects().map((project) => project.path);
}

/** Проекты, где будущие отметки прогона уже чинили: раз на процесс — чтение не пишет. */
const stampsRepaired = new Set<string>();

/**
 * Одноразовая починка отметок «из будущего» (агент писал местное время с буквой Z
 * до того, как панель стала штамповать результаты сама). Пока в проекте пишет
 * прогон или идёт ручная сессия, файлы групп не наши — попытка переносится на
 * следующее чтение.
 */
function repairStampsOnce(root: string, deps: TestsDeps): void {
  if (stampsRepaired.has(root)) return;
  if (deps.runs.get(root) || deps.manual.get(root)) return;
  stampsRepaired.add(root);
  try {
    repairFutureStamps(root, readRuns(root));
  } catch {
    // Чтение раздела не ломается из-за починки: битую группу покажет libraryIssues.
  }
}

/** Проекты, где записи «идёт» от прошлой жизни панели уже закрыты. */
const orphansSettled = new Set<string>();

/**
 * Реестр прогонов живёт в памяти процесса, поэтому запись агентского прогона
 * «идёт», оставшаяся от прошлой жизни панели, — сирота: её CLI умер вместе с
 * панелью. Закрываем такие раз на проект за жизнь процесса, не трогая живой.
 */
export function settleOrphansOnce(root: string, deps: TestsDeps): void {
  if (orphansSettled.has(root)) return;
  try {
    settleOrphanRuns(root, readRuns(root), deps.runs.get(root)?.id);
    // Отмечаем только удавшийся проход: разовый сбой чтения иначе оставлял
    // сироту «идёт» до следующего перезапуска панели.
    orphansSettled.add(root);
  } catch {
    // Чтение раздела не ломается из-за починки истории.
  }
}

/** Полное состояние раздела по одному проекту. */
export function buildView(root: string, deps: TestsDeps): ProjectTestsView {
  settleOrphansOnce(root, deps);
  repairStampsOnce(root, deps);
  const { branch, commit } = viewGitContext(root);
  return {
    projectPath: root,
    dir: TESTS_DIR,
    groups: readGroups(root),
    run: deps.runs.get(root),
    // Тот же путь к пользовательским настройкам, что и у записи: режим
    // `instructionFiles` решает, в каком файле соглашение вообще искать.
    hasConvention: hasConvention(root, deps.ctx.location.paths.settings),
    sharedSteps: readSharedSteps(root),
    environments: readEnvironments(root),
    schema: readSchema(root),
    views: readViews(root),
    plans: readPlans(root),
    // Пусто в обычном случае: список не пустой означает, что часть обвязки
    // прочитать не удалось, и окно настроек обязано сказать об этом вслух —
    // молчащий пустой список зовёт переписать чужой файл поверх.
    libraryIssues: emptyToUndefined(readLibraryIssues(root)),
    drafts: readDraftSummaries(root),
    autoAcceptDrafts: deps.ctx.store.isTestsAutoAccept(root),
    // Папка настоящих автотестов: где она, чья, сколько в ней файлов.
    e2e: e2eFolderView(root, deps.ctx.location.paths.appData),
    e2eRun: deps.e2eRuns?.get(root),
    // Своя команда прогона проекта (automation.json): с ней «Прогнать автотесты»
    // работает и без папки e2e.
    ...automationField(root),
    branch,
    commit,
  };
}

function automationField(root: string): { automation?: ProjectTestAutomationCommand } {
  const { automation } = readAutomation(root);
  return automation ? { automation } : {};
}

/** Пустой список — это `undefined`: поле необязательное, и пустого в ответе не будет. */
function emptyToUndefined<T>(items: T[]): T[] | undefined {
  return items.length > 0 ? items : undefined;
}

/** Список строк из тела запроса — пустой превращается в `undefined`. */
export function idList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const ids = value.map((item) => String(item)).filter(Boolean);
  return ids.length > 0 ? ids : undefined;
}
