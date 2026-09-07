import { resolve } from 'node:path';
import type { ProjectTestsView } from '@agentdeck/contracts';
import type { FastifyReply } from 'fastify';
import type { ServerContext } from '../../context.ts';
import { checkProjectDir } from '../../domains/projects.ts';
import {
  ProjectTestManualRegistry,
  ProjectTestRunRegistry,
  ProjectTestsError,
  ProjectTestsNotFoundError,
  TESTS_DIR,
  gitContext,
  hasConvention,
  readEnvironments,
  readGroups,
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
 * Ошибка домена — это 400 (404 для отсутствующего) с человеческим текстом, а не
 * падение маршрута.
 */
export function guard<T>(reply: FastifyReply, action: () => T): T | FastifyReply {
  try {
    return action();
  } catch (error) {
    if (error instanceof ProjectTestsError) {
      const status = error instanceof ProjectTestsNotFoundError ? 404 : 400;
      return reply.code(status).send({ message: error.message });
    }
    throw error;
  }
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
    branch,
    commit,
  };
}

/** Список строк из тела запроса — пустой превращается в `undefined`. */
export function idList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const ids = value.map((item) => String(item)).filter(Boolean);
  return ids.length > 0 ? ids : undefined;
}
