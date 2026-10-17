import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { SplitStatusAsked } from '@agentdeck/contracts/chat-handoff';
import type { ServerContext } from '../../context.ts';
import {
  STATUS_EFFORT,
  STATUS_MODEL,
  type StatusChats,
} from '../../domains/chat/status-chats/status-chats.ts';
import { expandAssignedModel } from '../../domains/model-cascade/model-cascade.ts';
import { apiTokenPath } from '../../lib/api-token/api-token.ts';
import { providerCliCommand } from '../../providers/cli/cli.ts';
import { getActiveProvider } from '../../providers/registry.ts';
import type { SplitLaunchDeps } from './split-launch.ts';

/**
 * Длиннее вопрос о ходе групп не бывает: ответ строится из сводки, а мегабайт
 * в теле запроса уехал бы в CLI целиком (ревью B1-F8).
 */
export const MAX_STATUS_QUESTION = 4000;

/**
 * «Спросить о ходе групп» из хаба родителя (5.1 плана экономии).
 *
 * Родитель разделения — разговор на 170–230 тыс. контекста, и после часа
 * тишины один вопрос «как там группы?» стоил перезаписи его кеша (160 тыс.) и
 * ~30 вызовов. Сводку групп панель уже строит, поэтому вопрос уходит в новый
 * лёгкий чат того же проекта: сводка — в начале каждого его хода
 * (`setChildrenBriefResolver`), профиль прогона — без MCP, навыков, правок и
 * оболочки (`statusRunProfile`). Писать самому родителю — по-прежнему его полем ввода.
 */
export function registerSplitStatusRoutes(
  app: FastifyInstance,
  ctx: ServerContext,
  deps: Pick<SplitLaunchDeps, 'runs'> & { statusChats?: StatusChats },
): void {
  const selfBaseUrl = `http://127.0.0.1:${process.env.PORT ?? 5178}`;

  app.post<{ Params: { parent: string }; Body: { question?: unknown } }>(
    '/api/chat/split/:parent/status-ask',
    (request, reply) => {
      const question =
        typeof request.body?.question === 'string' ? request.body.question.trim() : '';
      if (!question) {
        return reply
          .code(400)
          .send({ message: 'Вопрос пустой', messageCode: 'split-question-empty' });
      }
      if (question.length > MAX_STATUS_QUESTION) {
        return reply.code(400).send({
          message: `Вопрос длиннее ${MAX_STATUS_QUESTION} знаков`,
          messageCode: 'split-question-too-long',
          params: { max: MAX_STATUS_QUESTION },
        });
      }
      const record = ctx.store.getSplitPlan(request.params.parent);
      if (!deps.statusChats || !record) {
        return reply
          .code(404)
          .send({ message: 'Разделения с уровнями тут нет', messageCode: 'split-levels-missing' });
      }
      if (record.groups.length === 0) {
        return reply
          .code(404)
          .send({ message: 'Групп у разделения ещё нет', messageCode: 'split-groups-missing' });
      }
      // Лёгкий чат — чат Claude: профиль, сводка и флаги собраны под него.
      // Активный чужой CLI запускался с флагами Claude (ревью B1-F1).
      const provider = getActiveProvider(ctx.store);
      if (provider.id !== 'claude') {
        return reply.code(409).send({
          message: `Активен ${provider.name}: вопрос о ходе групп задаётся чатом Claude. Переключите активный CLI на Claude.`,
          messageCode: 'chat-send-foreign-provider',
          params: { provider: provider.name },
        });
      }
      // Метка времени не уникальна: два вопроса в одну миллисекунду делили ключ,
      // и второй молча пропадал (ревью B1-F5).
      const chatId = `new-${Date.now()}-${randomUUID().slice(0, 8)}-status`;
      // Алиас — в свежую модель семейства, как у остальных запусков
      // (`expandAssignedModel`): иначе первый ход шёл прошлым поколением (ревью A1-F5).
      const model = expandAssignedModel(
        ctx.models.current(provider.modelVendors ?? []).models,
        STATUS_MODEL,
      );
      // Запись — ДО старта: сводку первого хода реестр берёт по ней же.
      deps.statusChats.add(chatId, record.parentChatId);
      let started = false;
      try {
        started = deps.runs.start(
          chatId,
          {
            prompt: question,
            cwd: record.projectPath,
            command: providerCliCommand(provider),
            model,
            effort: STATUS_EFFORT,
            // Правки и оболочка сняты профилем; прочее, что не чтение, спросит человека.
            permissionMode: 'default',
            permissionPrompt: { runId: chatId, baseUrl: selfBaseUrl, tokenFile: apiTokenPath() },
          },
          { origin: 'chat', projectPath: record.projectPath },
        );
      } finally {
        if (!started) deps.statusChats.remove(chatId);
      }
      if (!started) {
        return reply.code(409).send({
          message: 'Вопрос не принят: прогон с этим ключом уже идёт',
          messageCode: 'split-status-not-started',
        });
      }
      const body: SplitStatusAsked = { chatId };
      return body;
    },
  );
}
