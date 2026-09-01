import { resolve } from 'node:path';
import type { FastifyInstance } from 'fastify';
import {
  parseSplitProposal,
  SPLIT_SYSTEM_PROMPT,
  type TaskSplitResult,
} from '@claude-control/contracts/task-split';
import type { ServerContext } from '../../context.ts';
import type { ChatRunRegistry } from '../../domains/chat/ChatRunRegistry.ts';
import { initiativePrompt } from '../../domains/chat/initiative.ts';
import { activateGroupsQuietly } from '../../domains/group-activation.ts';
import { splitTasks } from '../../domains/chat/ChatSplit.ts';
import { createChat, type ProviderChatService } from '../../domains/provider-chat.ts';
import { checkProjectDir } from '../../domains/projects.ts';
import { getActiveProvider } from '../../providers/registry.ts';
import { activeCliCommand } from '../../providers/cli.ts';

/**
 * Разделение списка задач по нескольким чатам — одним запросом.
 *
 * Почему эндпоинт, а не цикл в браузере: «завести копию → запустить прогон»
 * должно быть одной последовательностью с одним порядком и одним разбором
 * отказов. Циклом на клиенте это существовало бы дважды (панель и телефон) и
 * разошлось бы на первой же правке; тестом такое не покроешь вовсе.
 *
 * Клиенту остаётся ровно одно — открыть вкладки на путях, которые вернул ответ.
 *
 * Провайдер решает только ВИД чата: у Claude это разговор реестра прогонов, у
 * чужого CLI — разговор его собственного хранилища. Копии и ветки одни и те же:
 * git не знает, кто в них будет работать.
 */
export function registerChatSplitRoutes(
  app: FastifyInstance,
  ctx: ServerContext,
  deps: { runs: ChatRunRegistry; providerChats: ProviderChatService },
): void {
  const selfBaseUrl = `http://127.0.0.1:${process.env.PORT ?? 5178}`;

  app.post<{
    Body: {
      /** Каталог проекта, из которого делят. Обязателен: копии заводятся в нём. */
      projectPath?: string;
      /** Предложение агента — ровно то, что было в блоке ответа. */
      proposal?: unknown;
      /** Запускать прогоны сразу; false — только завести чаты с готовым заданием. */
      startRuns?: boolean;
      allowEdits?: boolean;
      model?: string;
      effort?: string;
      /**
       * Разговор, в котором человек согласился на разделение. Нужен ради дерева
       * в списке чатов: пять чатов, приехавших из одной просьбы, должны висеть
       * ветвями под ней, а не лежать в списке вперемешку с остальными.
       */
      parentChatId?: string;
    };
  }>('/api/chat/split', async (request, reply) => {
    // Автоподтверждения прав здесь нет намеренно: тумблер живёт на конкретном
    // разговоре и взводится тем же модулем, что потом принимает запросы прав.
    // Взвести его отсюда значило бы завести ВТОРОЙ объект сессии, о котором
    // маршрут прав ничего не знает, — тумблер бы не действовал, но выглядел бы
    // включённым. Человек включит его в том чате, за которым сядет.
    const { projectPath, startRuns, allowEdits, model, effort, parentChatId } = request.body ?? {};

    const problem = checkProjectDir(String(projectPath ?? ''));
    if (problem) return reply.code(400).send({ message: problem });
    const dir = resolve(projectPath as string);

    // Разбор тот же самый, которым панель узнаёт блок в ответе: два понимания
    // формата — два разных набора заведённых веток при одном и том же тексте.
    const proposal = parseSplitProposal(request.body?.proposal);
    if (!proposal) {
      return reply
        .code(400)
        .send({ message: 'Разделение не разобрано: нужны минимум две группы с задачами' });
    }

    const provider = getActiveProvider(ctx.store);
    const wantRuns = startRuns !== false;

    const result: TaskSplitResult = await splitTasks({
      projectPath: dir,
      proposal,
      startRuns: wantRuns,
      start: ({ chatId, prompt, cwd }) => {
        // Набор, привязанный к проекту, включается и здесь: агент, которого
        // завело разделение, работает в том же проекте и должен получить те же
        // правила и скиллы. Копия репозитория считается тем же проектом —
        // привязка знает про `<repo>-worktrees/<ветка>`.
        activateGroupsQuietly(
          { paths: ctx.location.paths, store: ctx.store, backupDir: ctx.backupDir },
          cwd,
          (error) => app.log.warn({ err: error }, 'group activation failed'),
        );

        return provider.id === 'claude'
          ? startClaude(chatId, prompt, cwd)
          : startForeign(chatId, prompt, cwd);
      },
    });

    // Дерево в списке чатов. Записываем ПОСЛЕ разделения и только по удачным
    // группам: ветвь, ведущая в чат, которого не завелось, — это не дерево, а
    // ложь о состоянии. Ключ здесь временный (`new-…`), и это правильно: под
    // ним чат уже открывается, а на настоящий `sessionId` связь переедет сама,
    // как только прогон его назовёт (слушатель в `index.ts`).
    if (parentChatId) {
      const createdAt = new Date().toISOString();
      for (const chat of result.chats) {
        ctx.store.setChatLink(chat.chatId, {
          parentChatId,
          title: chat.title,
          branch: chat.branch,
          createdAt,
        });
      }
    }

    return result;

    /** Прогон Claude — тот же путь, что и у обычной отправки в чат проекта. */
    function startClaude(chatId: string, prompt: string, cwd: string): boolean {
      const settings = ctx.store.getSettings();
      // Инициативы уходят в порождённые чаты ОБЕ и общей склейкой, а не «своя
      // здесь, чужая мимо»: агент в копии может обнаружить, что его собственная
      // группа опять распадается, и ровно так же вправе закрыть этап. Взяли бы
      // только разделение — тумблер продолжения молча не действовал бы во всех
      // чатах, заведённых разделением.
      const initiative = initiativePrompt(settings);
      return deps.runs.start(
        chatId,
        {
          prompt,
          cwd,
          command: activeCliCommand(ctx.store),
          model: model || settings.chatModel,
          effort: effort || settings.chatEffort,
          permissionMode: allowEdits ? 'acceptEdits' : 'default',
          permissionPrompt: { runId: chatId, baseUrl: selfBaseUrl },
          ...(initiative ? { appendSystemPrompt: initiative } : {}),
        },
        { projectPath: cwd },
      );
    }

    /**
     * Разговор чужого CLI. Идентификатор здесь СВОЙ (его выдаёт хранилище
     * провайдера), поэтому ключ из домена не используется — клиент открывает
     * такой чат по пути и по id из ответа.
     */
    function startForeign(chatId: string, prompt: string, cwd: string): boolean {
      const appData = ctx.location.paths.appData;
      const created = createChat(appData, provider.id, { title: chatId, workdir: cwd });
      if (!created) return false;
      // У чужого CLI инициатива — первая реплика переписки, а не флаг запуска.
      // Без неё порождённый чат вёл бы себя иначе, чем тот же чат после первого
      // же вопроса из панели, — а тумблер в настройках один.
      const initiative = initiativePrompt(ctx.store.getSettings());
      const outcome = deps.providerChats.send(
        appData,
        provider.id,
        created.id,
        { text: prompt },
        {
          provider,
          models: ctx.models.current(provider.modelVendors ?? []).models,
          ...(initiative ? { systemPrefix: initiative } : {}),
        },
      );
      return outcome.ok;
    }
  });

  /**
   * Просьба разделить задачи, посланная кнопкой, а не инициативой агента. Текст
   * живёт на сервере по той же причине, что и системная строка: он описывает
   * ФОРМАТ ответа, и второй его копии в клиенте быть не должно. Инструкцию
   * прикладываем целиком — кнопкой пользуются и при выключенной инициативе,
   * когда системной строки в прогоне нет вовсе.
   */
  app.get('/api/chat/split/request', () => ({
    prompt:
      'Раздели задачи из этого разговора на независимые группы и предложи разделение. ' +
      SPLIT_SYSTEM_PROMPT,
  }));
}
