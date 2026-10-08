import type { ProjectTestDraft } from '@agentdeck/contracts';
import type { FastifyInstance } from 'fastify';
import {
  ProjectTestsError,
  ProjectTestsNotFoundError,
  applyDraft,
  readDraft,
  readDrafts,
  readGroups,
  readRun,
  rejectDraft,
  rollbackDraft,
  similarTo,
  writeDraft,
} from '../../../domains/project-tests/project-tests.ts';
import {
  findSessionCwd,
  findTranscript,
  readWholeTranscriptRecords,
} from '../../../domains/chat/ChatHistory/ChatHistory.ts';
import { matchesProject } from '../../../domains/group-activation/group-activation.ts';
import { chatCaseDraft } from '../../../domains/chat/chat-case-draft/chat-case-draft.ts';
import { projectsDir } from '../../chat/paths.ts';
import {
  assertUnlocked,
  buildView,
  guard,
  idList,
  requireRoot,
  type TestsDeps,
} from '../shared/shared.ts';
import { coded } from '../../../lib/server-text/server-text.ts';
import { attachTextCodes } from '../../../lib/server-texts/server-texts.ts';

/**
 * Приёмка черновиков генерации.
 *
 * Черновик — это ПРЕДЛОЖЕНИЕ прогона, а библиотеку меняет панель. Поэтому все
 * маршруты здесь пишут в файлы групп сами и все проверяют занятость группы:
 * пока по ней идёт прогон, применять к ней чужие правки нельзя ровно по той же
 * причине, по которой нельзя сохранить кейс руками.
 *
 * Галочка «принимать сразу» — память ПАНЕЛИ о проекте, а не поле файла: она
 * выражает доверие человека к своей генерации, и в чужой репозиторий такому
 * знанию попадать незачем.
 */
/**
 * Похожие кейсы считает ПАНЕЛЬ, а не агент.
 *
 * В файле черновика `similarTo` может быть какое угодно: агент вправе его не
 * заполнить и вправе ошибиться в проценте, а проверить его слова нечем. Мера
 * считается здесь, по той же библиотеке, которую человек видит на экране, —
 * иначе строка «похоже на 82%» была бы обещанием, а не фактом.
 */
function withSimilar(root: string, draft: ProjectTestDraft): ProjectTestDraft {
  if (draft.error || draft.items.length === 0) return draft;
  const groups = readGroups(root);
  return {
    ...draft,
    items: draft.items.map((item) => ({
      ...item,
      similarTo: similarTo(item.testCase, groups, { excludeId: item.caseId }),
    })),
  };
}

/**
 * Черновик так, как его отдаёт `GET /drafts`: похожие посчитаны панелью, у
 * предупреждений есть коды. Ответы приёмки, отказа и отката кладутся клиентом
 * прямо в кэш окна (перечитать архивный черновик нельзя — 404), и сырой файл
 * там показывал `similarTo` агента и русские предупреждения в английском окне.
 */
function draftView(root: string, draft: ProjectTestDraft): ProjectTestDraft {
  return attachTextCodes(withSimilar(root, draft), ['warnings']);
}

export function registerTestDraftRoutes(app: FastifyInstance, deps: TestsDeps): void {
  /**
   * «Сделать кейс» из разговора: реплики человека и вызовы инструментов →
   * черновик с одним кейсом. Библиотеку он не меняет — человек принимает или
   * правит его в окне приёмки, как любую генерацию (решение владельца 30.09).
   */
  app.post<{ Body: { path?: string; chatId?: string; groupId?: string; chatTitle?: string } }>(
    '/api/project-tests/draft/from-chat',
    (request, reply) => {
      const root = requireRoot(request.body?.path, reply);
      if (!root) return reply;
      const chatId = request.body?.chatId?.trim() ?? '';
      return guard(reply, () => {
        // Ф19: черновик пишется в каталог проекта — значит, только в проект
        // реестра (или его копию ветки), а чат — только его собственный: иначе
        // любой каталог на диске получал `.agent/tests/drafts`, а кейс собирался
        // из разговора другого проекта.
        const project = deps.ctx.store
          .getProjects()
          .find((item) => matchesProject(item.path, root));
        if (!project) {
          throw coded(
            new ProjectTestsError(`Каталог «${root}» не проект реестра.`),
            'draft-chat-not-registered',
            { path: root },
          );
        }
        const known = /^[\w-]{1,128}$/.test(chatId);
        const transcript = known ? findTranscript(projectsDir(deps.ctx), chatId) : undefined;
        const cwd = transcript ? findSessionCwd(projectsDir(deps.ctx), chatId) : undefined;
        // Чужой чат отвечает тем же «не нашлось»: о разговорах других проектов
        // этот маршрут не рассказывает.
        if (!transcript || !cwd || !matchesProject(project.path, cwd)) {
          throw coded(
            new ProjectTestsNotFoundError(`Разговора «${chatId}» не нашлось.`),
            'draft-chat-not-found',
            { chatId },
          );
        }
        const groupId = request.body?.groupId?.trim();
        // Целиком: у большого транскрипта середина — это и есть сценарий (Ф15).
        const draft = chatCaseDraft(readWholeTranscriptRecords(transcript), {
          chatId,
          projectPath: root,
          now: new Date().toISOString(),
          ...(groupId ? { groupId } : {}),
          ...(request.body?.chatTitle ? { chatTitle: request.body.chatTitle } : {}),
        });
        if (!draft) {
          return reply.code(422).send({
            message: 'В разговоре нет шагов для кейса.',
            messageCode: 'draft-chat-no-steps',
          });
        }
        if (groupId) assertUnlocked(deps, root, groupId);
        writeDraft(root, draft);
        return {
          runId: draft.runId,
          draft: draftView(root, readDraft(root, draft.runId) ?? draft),
        };
      });
    },
  );

  /** Черновики проекта целиком — окно приёмки открывает один из них. */
  app.get<{ Querystring: { path?: string; runId?: string } }>(
    '/api/project-tests/drafts',
    (request, reply) => {
      const root = requireRoot(request.query.path, reply);
      if (!root) return reply;
      return guard(reply, () => {
        const runId = request.query.runId?.trim();
        if (!runId) {
          return attachTextCodes(
            { drafts: readDrafts(root), autoAccept: deps.ctx.store.isTestsAutoAccept(root) },
            ['warnings'],
          );
        }
        const draft = readDraft(root, runId);
        if (!draft)
          throw coded(
            new ProjectTestsNotFoundError(`Черновика «${runId}» в проекте нет.`),
            'draft-not-found',
            { runId },
          );
        return {
          drafts: [draftView(root, draft)],
          autoAccept: deps.ctx.store.isTestsAutoAccept(root),
        };
      });
    },
  );

  /**
   * Применить черновик — целиком или отмеченные кейсы.
   *
   * `auto: true` здесь значит «и дальше принимай сам»: человек посмотрел первые
   * предложения глазами и включил приём для остальных. Это то же положение
   * галочки, что и в форме запуска, — двух разных настроек для одного решения
   * быть не должно.
   */
  app.post<{
    Body: { path?: string; runId?: string; caseIds?: string[]; auto?: boolean };
  }>('/api/project-tests/draft/apply', (request, reply) => {
    const root = requireRoot(request.body?.path, reply);
    if (!root) return reply;
    const runId = request.body?.runId?.trim();
    if (!runId)
      return reply.code(400).send({ message: 'Не указан прогон.', messageCode: 'run-unspecified' });

    return guard(reply, () => {
      const auto = request.body?.auto === true;
      if (auto) deps.ctx.store.setTestsAutoAccept(root, true);
      const result = applyDraft(root, runId, {
        caseIds: idList(request.body?.caseIds),
        auto,
        now: new Date().toISOString(),
        assertUnlocked: (groupId) => assertUnlocked(deps, root, groupId),
        // Источник берётся из записи ПРОГОНА, а не из файла черновика: ссылку
        // на требование пишет панель, и обещание «строка матрицы перестанет
        // быть непокрытой» не должно зависеть от памяти модели.
        stamp: readRun(root, runId)?.generate,
      });
      return { ...result, draft: draftView(root, result.draft), view: buildView(root, deps) };
    });
  });

  /** Отклонить черновик: правки помечаются, файл уезжает в архив. */
  app.post<{ Body: { path?: string; runId?: string } }>(
    '/api/project-tests/draft/reject',
    (request, reply) => {
      const root = requireRoot(request.body?.path, reply);
      if (!root) return reply;
      const runId = request.body?.runId?.trim();
      if (!runId)
        return reply
          .code(400)
          .send({ message: 'Не указан прогон.', messageCode: 'run-unspecified' });
      return guard(reply, () => ({
        draft: draftView(root, rejectDraft(root, runId)),
        view: buildView(root, deps),
      }));
    },
  );

  /** Отменить приёмку: добавленное убрать, изменённое вернуть из снимка. */
  app.post<{ Body: { path?: string; runId?: string } }>(
    '/api/project-tests/draft/rollback',
    (request, reply) => {
      const root = requireRoot(request.body?.path, reply);
      if (!root) return reply;
      const runId = request.body?.runId?.trim();
      if (!runId)
        return reply
          .code(400)
          .send({ message: 'Не указан прогон.', messageCode: 'run-unspecified' });
      return guard(reply, () => {
        const result = rollbackDraft(root, runId, (groupId) => assertUnlocked(deps, root, groupId));
        return { ...result, draft: draftView(root, result.draft), view: buildView(root, deps) };
      });
    },
  );

  /** Положение галочки «принимать сразу» для этого проекта. */
  app.post<{ Body: { path?: string; enabled?: boolean } }>(
    '/api/project-tests/draft/auto',
    (request, reply) => {
      const root = requireRoot(request.body?.path, reply);
      if (!root) return reply;
      deps.ctx.store.setTestsAutoAccept(root, request.body?.enabled === true);
      return guard(reply, () => ({
        autoAccept: deps.ctx.store.isTestsAutoAccept(root),
        view: buildView(root, deps),
      }));
    },
  );
}
