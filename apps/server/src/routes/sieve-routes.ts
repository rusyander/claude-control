import type { FastifyInstance, FastifyReply } from 'fastify';
import type { SievesView } from '@agentdeck/contracts/sieves';
import type { ServerContext } from '../context.ts';
import { SieveStore } from '../domains/chat/sieve-store.ts';

/**
 * Сита перед MR — вкладка «Группы» в настройках (решение владельца 28.09).
 *
 * Встроенные сита — каталог контракта (`BUILTIN_SIEVES`), клиент читает его
 * сам; здесь только то, что панель выучила по тредам MR, и счёт блокеров по
 * классам. Выученное сито предложено, пока человек его не примет. Убрать выученное сито может человек: сито, которое не держит или
 * выучено из недоразумения, иначе ехало бы в каждое задание звена.
 */
export function registerSieveRoutes(app: FastifyInstance, ctx: ServerContext): void {
  const store = (): SieveStore => new SieveStore(ctx.location.paths.appData);
  const view = (): SievesView => {
    const { learned, tally, refused } = store().list();
    return { learned, tally, ...(refused ? { refused } : {}) };
  };
  const notFound = (reply: FastifyReply) =>
    reply
      .code(404)
      .send({ error: 'Этого выученного сита уже нет', messageCode: 'sieve-not-found' });

  app.get('/api/sieves', (): SievesView => view());

  /**
   * Принять предложенное сито — только рукой человека (реестр агента: `human:prompts`):
   * принятое сито становится постоянным заданием групп, а его текст написала модель
   * по реплике комментатора MR. `global` — для всех проектов.
   */
  app.post<{ Params: { id: string }; Body: { scope?: unknown } }>(
    '/api/sieves/learned/:id/accept',
    (request, reply) => {
      const scope = request.body?.scope === 'global' ? 'global' : 'project';
      if (!store().accept(request.params.id, scope)) return notFound(reply);
      return view();
    },
  );

  app.delete<{ Params: { id: string } }>('/api/sieves/learned/:id', (request, reply) => {
    if (!store().remove(request.params.id)) return notFound(reply);
    return view();
  });
}
