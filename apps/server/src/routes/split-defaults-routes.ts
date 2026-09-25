import type { FastifyInstance } from 'fastify';
import { SPLIT_DEFAULTS_BUILTIN, type SplitDefaultsView } from '@agentdeck/contracts/split-groups';
import type { ServerContext } from '../context.ts';
import { parseBody } from '../lib/request-body.ts';
import { splitDefaultsSchema } from '../providers/settings-validation.ts';

/**
 * Общие правила групп разделения — вкладка «Группы» в настройках.
 *
 * Отдельно от `PATCH /api/settings`: правила живут рядом с записями проектов
 * (`lib/app-store/split-settings.ts`), потому что проект их переопределяет, и
 * читать одно без другого конвейеру незачем.
 *
 * `onChange` зовётся для каждого проекта, у которого есть разделение: общий
 * потолок сменился — очередь сама двигается только концом чьей-то цепочки, и
 * поднятый потолок не значил бы ничего, пока хоть одна группа не доработает.
 */
export function registerSplitDefaultsRoutes(
  app: FastifyInstance,
  ctx: ServerContext,
  onChange?: (projectPath: string) => void,
): void {
  const view = (): SplitDefaultsView => ({
    defaults: ctx.store.getSplitDefaults(),
    builtIn: structuredClone(SPLIT_DEFAULTS_BUILTIN),
  });

  app.get('/api/split-defaults', () => view());

  app.put<{ Body: unknown }>('/api/split-defaults', async (request, reply) => {
    const body = parseBody(splitDefaultsSchema, request.body, reply);
    if (!body) return reply;
    ctx.store.setSplitDefaults({
      ...body,
      permissions: { ...SPLIT_DEFAULTS_BUILTIN.permissions, ...body.permissions },
    });
    for (const path of ctx.store.getSplitProjectPaths()) onChange?.(path);
    return view();
  });
}
