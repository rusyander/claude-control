import type { FastifyInstance } from 'fastify';
import type { ServerContext } from '../context.ts';
import {
  readPlugins,
  readAvailablePlugins,
  installPlugin,
  uninstallPlugin,
  enablePlugin,
  disablePlugin,
  updatePlugin,
  addMarketplace,
  removeMarketplace,
} from '../domains/plugins.ts';

/**
 * Маршруты плагинов. Каждая операция — вызов CLI, а он ходит в сеть и клонирует
 * репозитории, поэтому ответы приходят не мгновенно; интерфейс обязан показывать
 * ход выполнения, а не подвисать молча.
 */
export function registerPluginRoutes(app: FastifyInstance, ctx: ServerContext): void {
  app.get('/api/plugins', () => readPlugins(ctx.location.paths.root));

  app.get('/api/plugins/available', () => readAvailablePlugins());

  app.post<{ Body: { id: string } }>('/api/plugins/install', (request) =>
    installPlugin(request.body.id),
  );

  app.post<{ Params: { id: string } }>('/api/plugins/:id/uninstall', (request) =>
    uninstallPlugin(request.params.id),
  );

  app.post<{ Params: { id: string }; Body: { isEnabled: boolean } }>(
    '/api/plugins/:id/enabled',
    (request) =>
      request.body.isEnabled ? enablePlugin(request.params.id) : disablePlugin(request.params.id),
  );

  app.post<{ Params: { id: string } }>('/api/plugins/:id/update', (request) =>
    updatePlugin(request.params.id),
  );

  // Маркетплейсы: раньше источник добавляли только командой claude в терминале.
  app.post<{ Body: { source: string } }>('/api/plugins/marketplaces', (request) =>
    addMarketplace(request.body.source ?? ''),
  );

  app.delete<{ Params: { name: string } }>('/api/plugins/marketplaces/:name', (request) =>
    removeMarketplace(decodeURIComponent(request.params.name)),
  );
}
