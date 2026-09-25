import type { FastifyInstance, FastifyReply } from 'fastify';
import type {
  ProviderChatCreateRequest,
  ProviderChatEvent,
  ProviderChatPatchRequest,
  ProviderChatSendRequest,
} from '@agentdeck/contracts';
import {
  HANDOFF_DEFAULT_CHECKPOINT,
  restartHandoffProposal,
  restartRequestPrompt,
} from '@agentdeck/contracts/chat-handoff';
import { foreignChatKey } from '@agentdeck/contracts/foreign-chat-key';
import type { ServerContext } from '../context.ts';
import { initiativePrompt } from '../domains/chat/initiative.ts';
import { checkpointInside, statMtime, type HandoffChains } from '../domains/chat/ChatHandoff.ts';
import { getActiveProvider } from '../providers/registry.ts';
import {
  appendMessage,
  createChat,
  deleteChat,
  listChats,
  patchChat,
  readChat,
  readChatCascade,
  startForeignHandoff,
  foreignChatPrefix,
  type ProviderChatService,
  type ProviderChatSubscriber,
} from '../domains/provider-chat.ts';
import { checkProjectDir } from '../domains/projects.ts';
import { chatDeliveryFor } from '../domains/project-git.ts';

/**
 * Чат чужого провайдера: список разговоров, переписка, вопрос, поток ответа и
 * остановка. Ветка Claude здесь не участвует — у него свои маршруты, и на
 * попытку зайти сюда с активным Claude приходит отказ, а не «похожий» ответ.
 *
 * Провайдер берётся из настроек, а не из запроса: разговоры лежат по провайдерам
 * и принадлежат тому, кто активен. Иначе вкладка, забытая открытой после смены
 * провайдера, дописывала бы чужую переписку.
 */

/** Заголовки SSE: поток держим открытым, ничего не кэшируем. */
const SSE_HEADERS = {
  'Content-Type': 'text/event-stream',
  'Cache-Control': 'no-cache',
  Connection: 'keep-alive',
} as const;

export function registerProviderChatRoutes(
  app: FastifyInstance,
  ctx: ServerContext,
  chats: ProviderChatService,
  /**
   * Память цепочек продолжения (Т7) — та же, что у Claude: кнопка перезапуска
   * читает её номер шага и включает автомат, когда файл-опора ещё не готов.
   */
  chains: HandoffChains,
): void {
  /**
   * Активный провайдер или отказ. Claude отсекается здесь один раз, поэтому
   * ниже ни один обработчик не должен об этом помнить.
   */
  const requireProvider = (reply: FastifyReply): string | undefined => {
    const provider = getActiveProvider(ctx.store);
    if (provider.id === 'claude') {
      void reply.code(400).send({
        message: 'У Claude собственный чат — эти маршруты не для него.',
        messageCode: 'foreign-chat-not-for-claude',
      });
      return undefined;
    }
    return provider.id;
  };

  const appData = (): string => ctx.location.paths.appData;

  app.get('/api/provider-chat/chats', (_request, reply) => {
    const providerId = requireProvider(reply);
    if (!providerId) return reply;
    return listChats(appData(), providerId);
  });

  app.post<{ Body: ProviderChatCreateRequest }>('/api/provider-chat/chats', (request, reply) => {
    const providerId = requireProvider(reply);
    if (!providerId) return reply;

    const workdir = request.body?.workdir?.trim();
    if (workdir) {
      const problem = checkProjectDir(workdir);
      if (problem) return reply.code(400).send({ message: problem });
    }

    const chat = createChat(appData(), providerId, {
      ...(request.body?.title ? { title: request.body.title } : {}),
      ...(workdir ? { workdir } : {}),
    });

    return (
      chat ??
      reply
        .code(400)
        .send({ message: 'Не удалось создать разговор', messageCode: 'conversation-create-failed' })
    );
  });

  app.get<{ Params: { id: string } }>('/api/provider-chat/chats/:id', (request, reply) => {
    const providerId = requireProvider(reply);
    if (!providerId) return reply;

    const chat = readChat(appData(), providerId, request.params.id);
    return (
      chat ??
      reply.code(404).send({ message: 'Разговор не найден', messageCode: 'conversation-not-found' })
    );
  });

  app.patch<{ Params: { id: string }; Body: ProviderChatPatchRequest }>(
    '/api/provider-chat/chats/:id',
    (request, reply) => {
      const providerId = requireProvider(reply);
      if (!providerId) return reply;

      const workdir = request.body?.workdir;
      // Пустая строка — осознанное «убрать каталог», её проверять не нужно.
      if (workdir) {
        const problem = checkProjectDir(workdir.trim());
        if (problem) return reply.code(400).send({ message: problem });
      }

      const chat = patchChat(appData(), providerId, request.params.id, {
        ...(request.body?.title === undefined ? {} : { title: request.body.title }),
        ...(workdir === undefined ? {} : { workdir: workdir.trim() }),
      });

      return (
        chat ??
        reply
          .code(404)
          .send({ message: 'Разговор не найден', messageCode: 'conversation-not-found' })
      );
    },
  );

  app.delete<{ Params: { id: string } }>('/api/provider-chat/chats/:id', (request, reply) => {
    const providerId = requireProvider(reply);
    if (!providerId) return reply;

    // Идущий ответ снимаем: иначе он допишется в файл, которого уже нет.
    chats.stop(request.params.id);

    return deleteChat(appData(), providerId, request.params.id)
      ? { ok: true }
      : reply
          .code(404)
          .send({ message: 'Разговор не найден', messageCode: 'conversation-not-found' });
  });

  /**
   * Вопрос. Ответ здесь НЕ ждём: он идёт потоком по отдельному маршруту, а этот
   * возвращает записанную реплику пользователя. Так вкладка может закрыться и
   * вернуться, не потеряв ответ.
   */
  app.post<{ Params: { id: string }; Body: ProviderChatSendRequest }>(
    '/api/provider-chat/chats/:id/send',
    (request, reply) => {
      const providerId = requireProvider(reply);
      if (!providerId) return reply;

      const text = typeof request.body?.text === 'string' ? request.body.text.trim() : '';
      if (!text)
        return reply.code(400).send({ message: 'Пустой запрос', messageCode: 'request-empty' });

      const attachments = Array.isArray(request.body?.attachments)
        ? request.body.attachments.filter((path): path is string => typeof path === 'string')
        : [];

      const provider = getActiveProvider(ctx.store);
      // Инициативы панели — у чужого CLI это первая реплика переписки, а не
      // флаг: системного промпта у них нет. Правило про AskUserQuestion сюда не
      // идёт: такого инструмента у чужого CLI нет вовсе.
      // Доставка до MR — как у чата Claude: обычному разговору проекта, не
      // ребёнку разделения (его доставка — в задании группы).
      const workdir = readChat(appData(), providerId, request.params.id)?.workdir;
      const child = ctx.store.getChatLink(foreignChatKey(providerId, request.params.id));
      const delivery =
        workdir && !child ? chatDeliveryFor(ctx.store, workdir, { foreign: true }) : undefined;
      const initiative = initiativePrompt(ctx.store.getSettings(), {
        foreign: true,
        // Чат группы делить дальше не предлагается — ни звену, ни ответу
        // человека в него (живой прогон 25.09: ответ в группу получал
        // инструкцию разделения, которой у звена нет).
        ...(child ? { splitMuted: true } : {}),
        ...(delivery ? { delivery } : {}),
      });
      const outcome = chats.send(
        appData(),
        providerId,
        request.params.id,
        { text, attachments },
        {
          provider,
          // Только кэш: чат не должен ждать сеть ради имени модели.
          models: ctx.models.current(provider.modelVendors ?? []).models,
          ...(initiative ? { systemPrefix: initiative } : {}),
        },
      );

      if (!outcome.ok) {
        return outcome.reason === 'already_running'
          ? reply.code(409).send({
              message: 'Ответ на предыдущий вопрос ещё идёт',
              messageCode: 'foreign-answer-running',
            })
          : reply
              .code(404)
              .send({ message: 'Разговор не найден', messageCode: 'conversation-not-found' });
      }

      return { message: outcome.message };
    },
  );

  /**
   * «Перезапустить сессию» у чужого CLI (Т7). Сессии у него нет вовсе, поэтому
   * перезапуск — это НОВЫЙ разговор в том же каталоге, с контрольной точкой и
   * исходным заданием; так это и называется человеку.
   *
   * Ответа два, как и у Claude. Файл-опора свежее последней реплики человека —
   * продолжение заводится прямо здесь. Несвежий — панель возвращает просьбу его
   * обновить, вкладка отправляет её обычным сообщением, а автомат для этого
   * разговора включается: человек уже нажал кнопку, и спрашивать его согласие
   * второй раз, когда агент допишет опору, незачем.
   */
  app.post<{ Params: { id: string } }>('/api/provider-chat/chats/:id/restart', (request, reply) => {
    const providerId = requireProvider(reply);
    if (!providerId) return reply;

    const chatId = request.params.id;
    if (chats.status(chatId).isRunning) {
      return reply.code(409).send({
        message: 'Ответ ещё идёт: дождитесь конца хода или остановите его, потом перезапускайте',
        messageCode: 'foreign-restart-running',
      });
    }

    const chat = readChat(appData(), providerId, chatId);
    if (!chat)
      return reply
        .code(404)
        .send({ message: 'Разговор не найден', messageCode: 'conversation-not-found' });
    if (!chat.workdir) {
      return reply.code(400).send({
        message: 'У разговора нет рабочего каталога — новый разговор заводить негде',
        messageCode: 'foreign-restart-no-cwd',
      });
    }

    const key = foreignChatKey(providerId, chatId);
    // Свежесть — относительно последней реплики человека: всё, что агент
    // записал после неё, записано в этом разговоре.
    const target = checkpointInside(chat.workdir, HANDOFF_DEFAULT_CHECKPOINT);
    const mtime = target ? statMtime(target) : undefined;
    const lastHuman = chat.messages.findLast((message) => message.role === 'user');
    const lastTurnAt = lastHuman ? Date.parse(lastHuman.at) : Number.NaN;

    if (mtime === undefined || !Number.isFinite(lastTurnAt) || mtime < lastTurnAt) {
      chains.setAuto([key], true);
      return {
        mode: 'requested' as const,
        prompt: restartRequestPrompt(HANDOFF_DEFAULT_CHECKPOINT),
      };
    }

    const provider = getActiveProvider(ctx.store);
    const cascade = readChatCascade(appData(), providerId, chatId);
    const outcome = startForeignHandoff(
      {
        providerId,
        chatId,
        ok: true,
        text: '',
        // Кнопку нажал человек, и предохранитель «файл-опора свежее старта»
        // тут ни при чём: свежесть уже проверена по его последней реплике.
        startedAt: 0,
        cwd: chat.workdir,
        title: chat.title,
        task: chat.messages.find((message) => message.role === 'user')?.content ?? '',
        proposal: restartHandoffProposal(HANDOFF_DEFAULT_CHECKPOINT, { foreign: true }),
        ...(chat.model ? { model: chat.model } : {}),
        ...(chat.effort ? { effort: chat.effort } : {}),
        ...(cascade ? { cascade } : {}),
        ...(ctx.store.getChatLink(key) ? { link: ctx.store.getChatLink(key) } : {}),
      },
      {
        chains,
        open: (input) =>
          createChat(appData(), providerId, {
            title: input.title,
            workdir: input.cwd,
            ...(input.model ? { model: input.model } : {}),
            ...(input.effort ? { effort: input.effort } : {}),
            ...(input.cascade ? { cascade: input.cascade } : {}),
          })?.id,
        run: (nextId, prompt, header) => {
          const prefix = header
            ? foreignChatPrefix(header, ctx.store.getSettings())
            : initiativePrompt(ctx.store.getSettings(), { foreign: true });
          chats.send(
            appData(),
            providerId,
            nextId,
            { text: prompt },
            {
              provider,
              models: ctx.models.current(provider.modelVendors ?? []).models,
              ...(prefix ? { systemPrefix: prefix } : {}),
            },
          );
        },
        saveLink: (chatKey, link) => ctx.store.setChatLink(chatKey, link),
      },
    );

    if (!outcome?.chatId) {
      return reply.code(500).send({
        message: 'Продолжение не заведено: хранилище отказало',
        messageCode: 'foreign-continuation-store-failed',
      });
    }
    // Заметка в СТАРОМ разговоре: человек вернётся именно в него и должен
    // увидеть, куда ушла работа.
    if (outcome.notice) {
      appendMessage(appData(), providerId, chatId, {
        role: 'notice',
        content: outcome.notice,
      });
    }
    return {
      mode: 'started' as const,
      chatId: outcome.chatId,
      ...(outcome.chainDepth !== undefined ? { chainDepth: outcome.chainDepth } : {}),
    };
  });

  app.post<{ Params: { id: string } }>('/api/provider-chat/chats/:id/stop', (request, reply) => {
    const providerId = requireProvider(reply);
    if (!providerId) return reply;
    // Кнопка человека: группа разделения встаёт на паузу, как у Claude (89c).
    return { stopped: chats.stopByHuman(request.params.id) };
  });

  /** Что происходит прямо сейчас — этим вкладка догоняет пропущенное после F5. */
  app.get<{ Params: { id: string } }>('/api/provider-chat/chats/:id/status', (request, reply) => {
    const providerId = requireProvider(reply);
    if (!providerId) return reply;
    return chats.status(request.params.id);
  });

  /**
   * Поток ответа. Обрыв соединения отцепляет слушателя и НЕ трогает прогон:
   * второй попытки у одноразового CLI не будет.
   */
  app.get<{ Params: { id: string } }>('/api/provider-chat/chats/:id/stream', (request, reply) => {
    const providerId = requireProvider(reply);
    if (!providerId) return reply;

    return new Promise<void>((resolve) => {
      reply.raw.writeHead(200, SSE_HEADERS);

      // Пинг не даёт прокси и браузеру закрыть молчащее соединение, пока CLI
      // думает над первым словом ответа.
      const heartbeat = setInterval(() => {
        try {
          reply.raw.write(': ping\n\n');
        } catch {
          // Соединение уже закрыто — обработчик close всё уберёт.
        }
      }, 10_000);

      let closed = false;
      const finish = (): void => {
        if (closed) return;
        closed = true;
        clearInterval(heartbeat);
        try {
          reply.raw.end();
        } catch {
          // уже закрыто
        }
        resolve();
      };

      const subscriber: ProviderChatSubscriber = {
        send: (event: ProviderChatEvent) => {
          try {
            reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
          } catch {
            // Клиент отвалился — close-обработчик отцепит.
          }
        },
        close: finish,
      };

      const unsubscribe = chats.subscribe(request.params.id, subscriber);

      reply.raw.on('close', () => {
        clearInterval(heartbeat);
        unsubscribe();
        resolve();
      });
    });
  });
}
