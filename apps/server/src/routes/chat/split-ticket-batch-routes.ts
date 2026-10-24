import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyReply } from 'fastify';
import {
  bundleSplitTickets,
  clusterSplitTickets,
  openSplitTickets,
  type SplitTicketTaken,
} from '@agentdeck/contracts/split-ticket-batch';
import type { ServerContext } from '../../context.ts';
import type { ChatRunRegistry } from '../../domains/chat/ChatRunRegistry/ChatRunRegistry.ts';
import { initiativePrompt } from '../../domains/chat/initiative/initiative.ts';
import type { SplitConveyor } from '../../domains/chat/split-conveyor/split-conveyor.ts';
import { takePrompt, type TicketLang } from '../../domains/chat/split-ticket-batch/compose.ts';
import type { TicketAsk } from '../../domains/chat/split-ticket-batch/prepare.ts';
import { publishTickets } from '../../domains/chat/split-ticket-batch/publish.ts';
import {
  ticketTarget,
  type TicketTargetTracker,
} from '../../domains/chat/split-ticket-batch/target.ts';
import { atlassianBatchTracker } from '../../domains/chat/split-ticket-tracker.ts';
import { IntegrationError } from '../../domains/integrations/errors.ts';
import { apiTokenPath } from '../../lib/api-token/api-token.ts';
import { codeOf } from '../../lib/server-text/server-text.ts';
import { providerCliCommand } from '../../providers/cli/cli.ts';
import { getActiveProvider } from '../../providers/registry.ts';
import { fail } from '../integrations/shared.ts';

/**
 * «Разобрать…» в хабе (владелец 24.10.2026): предложенные группами тикеты разом.
 *
 * Три ручки, и все — кнопки человека (реестр возможностей: `human:`), агенту
 * панели и модели закрыты: публикация пишет в чужой сервис, а «Решить здесь»
 * заводит работу в проекте. Проход модели внутри публикации ничего не пишет —
 * пишет сервер по его итогу, и только в ответ на клик.
 */
export interface SplitTicketBatchDeps {
  conveyor?: SplitConveyor;
  runs: ChatRunRegistry;
  /** Jira разом; по умолчанию — из интеграций (подменяется проверками). */
  batchTracker?: TicketTargetTracker;
  /** Вызов модели панели для сведения находок (`groupAsk`); нет — склейки без модели. */
  ticketAsk?: TicketAsk;
}

const langOf = (value: unknown): TicketLang => (value === 'en' ? 'en' : 'ru');
const text = (value: unknown, max = 200): string =>
  typeof value === 'string' ? value.trim().slice(0, max) : '';

function conveyorOff(reply: FastifyReply): FastifyReply {
  return reply
    .code(404)
    .send({ message: 'Конвейер уровней выключен', messageCode: 'split-conveyor-off' });
}

export function registerSplitTicketBatchRoutes(
  app: FastifyInstance,
  ctx: ServerContext,
  deps: SplitTicketBatchDeps,
): void {
  const tracker =
    deps.batchTracker ??
    atlassianBatchTracker(
      () => ctx.store,
      () => ctx.location.paths.appData,
    );
  const selfBaseUrl = `http://127.0.0.1:${process.env.PORT ?? 5178}`;
  const missing = (reply: FastifyReply) =>
    reply
      .code(404)
      .send({ message: 'Разделения с уровнями тут нет', messageCode: 'split-levels-missing' });

  /** Куда заводить: сайт подключённой Jira, проекты, типы задач выбранного проекта. */
  app.get<{ Params: { parent: string }; Querystring: { project?: string; last?: string } }>(
    '/api/chat/split/:parent/tickets/target',
    async (request, reply) => {
      const record = ctx.store.getSplitPlan(request.params.parent);
      if (!record) return missing(reply);
      return ticketTarget(tracker, record.projectPath, {
        project: text(request.query.project),
        last: text(request.query.last),
      });
    },
  );

  /**
   * «Опубликовать в Jira»: клик — согласие человека. Модель сводит открытые
   * находки в задачи, сервер заводит их по одной; двойной клик и вторая
   * вкладка ждут первую публикацию и второй раз находку не заводят.
   */
  app.post<{
    Params: { parent: string };
    Body: { projectKey?: unknown; issueType?: unknown; lang?: unknown; retryFailed?: unknown };
  }>('/api/chat/split/:parent/tickets/publish', async (request, reply) => {
    if (!deps.conveyor) return conveyorOff(reply);
    const conveyor = deps.conveyor;
    const parentChatId = request.params.parent;
    if (!ctx.store.getSplitPlan(parentChatId)) return missing(reply);
    const projectKey = text(request.body?.projectKey, 50);
    if (!projectKey) {
      return reply.code(400).send({
        message: 'не указан проект Jira',
        messageCode: 'request-jira-project-missing',
        params: { field: 'projectKey' },
      });
    }
    if (!tracker.connected()) {
      return reply.code(404).send({
        message: 'Jira не подключена: включите её и сохраните токен в настройках панели.',
        messageCode: 'integration-not-connected',
        params: { title: 'Jira' },
      });
    }
    try {
      return await publishTickets(
        {
          marks: conveyor.ticketMarks,
          record: (parent) => ctx.store.getSplitPlan(parent),
          tracker,
          ...(deps.ticketAsk ? { ask: deps.ticketAsk } : {}),
        },
        {
          parentChatId,
          projectKey,
          issueType: text(request.body?.issueType, 100) || 'Bug',
          lang: langOf(request.body?.lang),
          retryFailed: request.body?.retryFailed === true,
        },
      );
    } catch (error) {
      if (error instanceof IntegrationError) return fail(reply, error);
      return reply.code(409).send({ message: (error as Error).message, ...codeOf(error) });
    }
  });

  /**
   * «Решить здесь»: ОДИН новый чат проекта с задачей из открытых находок
   * (явные повторы сведены той же склейкой, без модели). Запуск — тот же, что
   * у вопроса о ходе групп и продолжения: реестр прогонов Claude, модель и
   * глубина из настроек чата, права — спрашивать человека, инициатива — та же,
   * что у обычного чата (агент может сам предложить разделение).
   */
  app.post<{ Params: { parent: string }; Body: { lang?: unknown } }>(
    '/api/chat/split/:parent/tickets/take',
    (request, reply) => {
      if (!deps.conveyor) return conveyorOff(reply);
      const record = ctx.store.getSplitPlan(request.params.parent);
      if (!record) return missing(reply);
      const clusters = clusterSplitTickets(openSplitTickets(record.groups));
      if (clusters.length === 0) {
        return reply.code(409).send({
          message: 'Открытых предложений тикетов нет: все уже заведены или взяты в чат',
          messageCode: 'split-ticket-batch-empty',
        });
      }
      const provider = getActiveProvider(ctx.store);
      if (provider.id !== 'claude') {
        return reply.code(409).send({
          message: `Активен ${provider.name}: этот маршрут запускает только чат Claude. Сообщение не отправлено — пишите в чат ${provider.name} на компьютере или переключите активный CLI на Claude.`,
          messageCode: 'chat-send-foreign-provider',
          params: { provider: provider.name },
        });
      }
      const settings = ctx.store.getSettings();
      const chatId = `new-${Date.now()}-${randomUUID().slice(0, 8)}`;
      const initiative = initiativePrompt(settings);
      const started = deps.runs.start(
        chatId,
        {
          prompt: takePrompt(bundleSplitTickets(clusters), langOf(request.body?.lang)),
          cwd: record.projectPath,
          command: providerCliCommand(provider),
          ...(settings.chatModel ? { model: settings.chatModel } : {}),
          ...(settings.chatEffort ? { effort: settings.chatEffort } : {}),
          permissionMode: 'default',
          permissionPrompt: { runId: chatId, baseUrl: selfBaseUrl, tokenFile: apiTokenPath() },
          ...(initiative ? { appendSystemPrompt: initiative } : {}),
        },
        { origin: 'chat', projectPath: record.projectPath },
      );
      if (!started) {
        return reply.code(409).send({
          message: 'Чат не запустился: прогон с этим ключом уже идёт',
          messageCode: 'split-ticket-take-not-started',
        });
      }
      const keys = clusters.flatMap((cluster) => cluster.tickets.map((ticket) => ticket.key));
      const count = deps.conveyor.ticketMarks.markTaken(record.parentChatId, keys, chatId);
      const body: SplitTicketTaken = { chatId, count };
      return body;
    },
  );
}
