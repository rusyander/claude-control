import type { FastifyInstance, FastifyReply } from 'fastify';
import type {
  ProviderChatCreateRequest,
  ProviderChatEvent,
  ProviderChatPatchRequest,
  ProviderChatSendRequest,
} from '@claude-control/contracts';
import type { ServerContext } from '../context.ts';
import { initiativePrompt } from '../domains/chat/initiative.ts';
import { getActiveProvider } from '../providers/registry.ts';
import {
  createChat,
  deleteChat,
  listChats,
  patchChat,
  readChat,
  type ProviderChatService,
  type ProviderChatSubscriber,
} from '../domains/provider-chat.ts';
import { checkProjectDir } from '../domains/projects.ts';

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
): void {
  /**
   * Активный провайдер или отказ. Claude отсекается здесь один раз, поэтому
   * ниже ни один обработчик не должен об этом помнить.
   */
  const requireProvider = (reply: FastifyReply): string | undefined => {
    const provider = getActiveProvider(ctx.store);
    if (provider.id === 'claude') {
      void reply
        .code(400)
        .send({ message: 'У Claude собственный чат — эти маршруты не для него.' });
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

    return chat ?? reply.code(400).send({ message: 'Не удалось создать разговор' });
  });

  app.get<{ Params: { id: string } }>('/api/provider-chat/chats/:id', (request, reply) => {
    const providerId = requireProvider(reply);
    if (!providerId) return reply;

    const chat = readChat(appData(), providerId, request.params.id);
    return chat ?? reply.code(404).send({ message: 'Разговор не найден' });
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

      return chat ?? reply.code(404).send({ message: 'Разговор не найден' });
    },
  );

  app.delete<{ Params: { id: string } }>('/api/provider-chat/chats/:id', (request, reply) => {
    const providerId = requireProvider(reply);
    if (!providerId) return reply;

    // Идущий ответ снимаем: иначе он допишется в файл, которого уже нет.
    chats.stop(request.params.id);

    return deleteChat(appData(), providerId, request.params.id)
      ? { ok: true }
      : reply.code(404).send({ message: 'Разговор не найден' });
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
      if (!text) return reply.code(400).send({ message: 'Пустой запрос' });

      const attachments = Array.isArray(request.body?.attachments)
        ? request.body.attachments.filter((path): path is string => typeof path === 'string')
        : [];

      const provider = getActiveProvider(ctx.store);
      // Инициативы панели — у чужого CLI это первая реплика переписки, а не
      // флаг: системного промпта у них нет. Правило про AskUserQuestion сюда не
      // идёт: такого инструмента у чужого CLI нет вовсе.
      const initiative = initiativePrompt(ctx.store.getSettings(), { foreign: true });
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
          ? reply.code(409).send({ message: 'Ответ на предыдущий вопрос ещё идёт' })
          : reply.code(404).send({ message: 'Разговор не найден' });
      }

      return { message: outcome.message };
    },
  );

  app.post<{ Params: { id: string } }>('/api/provider-chat/chats/:id/stop', (request, reply) => {
    const providerId = requireProvider(reply);
    if (!providerId) return reply;
    return { stopped: chats.stop(request.params.id) };
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
