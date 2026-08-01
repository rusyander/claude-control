import type { FastifyInstance } from 'fastify';
import type { ServerContext } from '../../context.ts';
import {
  readProviderPluginsInfo,
  readProviderPluginFile,
  parseProviderPluginFileDraft,
  saveProviderPluginFile,
  deleteProviderPluginFile,
  parseProviderPluginPackagesDraft,
  saveProviderPluginPackages,
  describePluginError,
} from '../../domains/provider-plugins.ts';
import { UnrecognizedFormatError } from '../../lib/format-errors.ts';
import { done } from '../write-result.ts';
import { guardedBy, requireTarget } from './target.ts';
import {
  FORMAT_UNRECOGNIZED,
  INVALID_PLUGIN_FILE_DRAFT,
  INVALID_PLUGIN_PACKAGES_DRAFT,
  PLUGINS_UNSUPPORTED,
} from './messages.ts';

/** Выполнить операцию домена плагинов, разложив её отказы в коды ответа. */
const guardedPlugin = guardedBy(describePluginError);

/**
 * Плагины проекта: каталог `.opencode/plugins` + `plugin` (OPENCODE-4).
 *
 * Защита путей та же, что у глобального каталога: корнем служит уже проверенный
 * каталог проекта, наружу него ни `..`, ни ссылка в сегменте не выпускают.
 */
export function registerProviderProjectPluginsRoutes(
  app: FastifyInstance,
  ctx: ServerContext,
): void {
  app.get<{ Params: { id: string } }>('/api/projects/:id/provider/plugins', (request, reply) => {
    const target = requireTarget(ctx, request.params.id, reply);
    if (!target) return reply;
    if (!target.plugins) return reply.code(400).send(PLUGINS_UNSUPPORTED);

    return readProviderPluginsInfo(target.plugins);
  });

  app.get<{ Params: { id: string }; Querystring: { path?: string } }>(
    '/api/projects/:id/provider/plugins/file',
    (request, reply) => {
      const target = requireTarget(ctx, request.params.id, reply);
      if (!target) return reply;
      const plugins = target.plugins;
      if (!plugins) return reply.code(400).send(PLUGINS_UNSUPPORTED);

      const raw = request.query.path;
      if (typeof raw !== 'string' || !raw) return reply.code(400).send(INVALID_PLUGIN_FILE_DRAFT);

      return guardedPlugin(reply, () => readProviderPluginFile(plugins, raw));
    },
  );

  app.put<{ Params: { id: string }; Body: unknown }>(
    '/api/projects/:id/provider/plugins/file',
    (request, reply) => {
      const target = requireTarget(ctx, request.params.id, reply);
      if (!target) return reply;
      const plugins = target.plugins;
      if (!plugins) return reply.code(400).send(PLUGINS_UNSUPPORTED);

      const draft = parseProviderPluginFileDraft(request.body);
      if (!draft) return reply.code(400).send(INVALID_PLUGIN_FILE_DRAFT);

      return guardedPlugin(reply, () => {
        const saved = saveProviderPluginFile(plugins, draft, ctx.backupDir);
        return { ...done(saved.backupPath), path: saved.path, fullPath: saved.fullPath };
      });
    },
  );

  app.delete<{ Params: { id: string }; Querystring: { path?: string } }>(
    '/api/projects/:id/provider/plugins/file',
    (request, reply) => {
      const target = requireTarget(ctx, request.params.id, reply);
      if (!target) return reply;
      const plugins = target.plugins;
      if (!plugins) return reply.code(400).send(PLUGINS_UNSUPPORTED);

      const raw = request.query.path;
      if (typeof raw !== 'string' || !raw) return reply.code(400).send(INVALID_PLUGIN_FILE_DRAFT);

      return guardedPlugin(reply, () => {
        const removed = deleteProviderPluginFile(plugins, raw, ctx.backupDir);
        return { ...done(removed.backupPath), path: removed.path };
      });
    },
  );

  app.put<{ Params: { id: string }; Body: unknown }>(
    '/api/projects/:id/provider/plugins/packages',
    (request, reply) => {
      const target = requireTarget(ctx, request.params.id, reply);
      if (!target) return reply;
      if (!target.plugins) return reply.code(400).send(PLUGINS_UNSUPPORTED);

      const packages = parseProviderPluginPackagesDraft(request.body);
      if (!packages) return reply.code(400).send(INVALID_PLUGIN_PACKAGES_DRAFT);

      try {
        return done(saveProviderPluginPackages(target.plugins, packages, ctx.backupDir));
      } catch (error) {
        if (error instanceof UnrecognizedFormatError)
          return reply.code(422).send(FORMAT_UNRECOGNIZED);
        throw error;
      }
    },
  );
}
