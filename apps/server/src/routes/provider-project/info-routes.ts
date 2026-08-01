import type { FastifyInstance } from 'fastify';
import type { ServerContext } from '../../context.ts';
import { providerProjectInfo } from '../../domains/provider-projects.ts';
import { requireTarget } from './target.ts';

/** Что активный провайдер умеет на уровне этого проекта — из чего интерфейс строит вкладки. */
export function registerProviderProjectInfoRoutes(app: FastifyInstance, ctx: ServerContext): void {
  app.get<{ Params: { id: string } }>('/api/projects/:id/provider', (request, reply) => {
    const target = requireTarget(ctx, request.params.id, reply);
    if (!target) return reply;
    return providerProjectInfo(target);
  });
}
