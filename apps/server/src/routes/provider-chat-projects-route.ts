import type { FastifyInstance } from 'fastify';
import type { ServerContext } from '../context.ts';
import { listAllProjects } from '../domains/provider-chat.ts';
import { getProvider } from '../providers/registry.ts';
import { sendConditional } from '../lib/conditional-get.ts';
import { projectsDir } from './chat/paths.ts';

/**
 * Проекты для чата чужого провайдера: каталоги Claude и всех остальных CLI одним
 * списком, у каждой строки — кто в ней работал и можно ли начать здесь новый
 * разговор. Склейка на сервере, а не в браузере: источники — транскрипты Claude
 * и файлы панели, и оба читаются только здесь.
 *
 * Активный провайдер не проверяется: список только читает, а разговор в
 * выбранном каталоге заводит обычный `POST /api/provider-chat/chats` со своей
 * проверкой каталога.
 */
export function registerProviderChatProjectsRoute(app: FastifyInstance, ctx: ServerContext): void {
  app.get('/api/provider-chat/projects', (request, reply) =>
    sendConditional(
      request,
      reply,
      listAllProjects({
        projectsDir: projectsDir(ctx),
        appDataDir: ctx.location.paths.appData,
        providerName: (id) => getProvider(id).name,
      }),
    ),
  );
}
