import { resolve } from 'node:path';
import type { ProjectTestsView } from '@agentdeck/contracts';
import type { FastifyReply } from 'fastify';
import type { ServerContext } from '../../context.ts';
import { checkProjectDir } from '../../domains/projects.ts';
import {
  ProjectTestManualRegistry,
  ProjectTestRunRegistry,
  ProjectTestsError,
  ProjectTestsLockedError,
  ProjectTestsNotFoundError,
  TESTS_DIR,
  gitContext,
  hasConvention,
  readDraftSummaries,
  readEnvironments,
  readGroups,
  readLibraryIssues,
  readPlans,
  readSchema,
  readSharedSteps,
  readViews,
} from '../../domains/project-tests.ts';

/**
 * Общее для всех маршрутов раздела тестов: проверка каталога, перевод ошибок
 * домена в ответы и сборка полного вида.
 *
 * Каталог приходит путём, как у файлов и git проекта: вкладку открывают на любой
 * папке, и в реестре проектов её может не быть вовсе.
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
}

/** Каталог проекта из запроса. Ответ уже отправлен, если путь не годится. */
export function requireRoot(path: unknown, reply: FastifyReply): string | undefined {
  const problem = checkProjectDir(String(path ?? ''));
  if (problem) {
    void reply.code(400).send({ message: problem });
    return undefined;
  }
  return resolve(String(path));
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
  return reply.code(status).send({ message: error.message, ...locked });
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
  throw new ProjectTestsLockedError(
    `По этой группе идёт прогон (${runId}) — он пишет в тот же файл. Дождись конца или останови его.`,
    runId,
  );
}

/** Полное состояние раздела по одному проекту. */
export function buildView(root: string, deps: TestsDeps): ProjectTestsView {
  const { branch, commit } = gitContext(root);
  return {
    projectPath: root,
    dir: TESTS_DIR,
    groups: readGroups(root),
    run: deps.runs.get(root),
    hasConvention: hasConvention(root),
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
    branch,
    commit,
  };
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
