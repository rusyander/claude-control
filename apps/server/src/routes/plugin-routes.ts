import type { FastifyInstance } from 'fastify';
import type { ServerContext } from '../context.ts';
import type { PluginScaffoldRequest } from '@claude-control/contracts';
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
  scaffoldPlugin,
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

  // Скаффолдер: пишет файлы в выбранный пользователем каталог (не в ~/.claude),
  // поэтому CLI не задействован — это обычная запись на диск с проверками пути.
  // Отказ (папка занята, плохое имя) отдаём полем ok=false, как и CLI-команды:
  // форма разбирает его сама и показывает причину, а не ловит сетевую ошибку.
  app.post<{ Body: PluginScaffoldRequest }>('/api/plugins/scaffold', (request) =>
    scaffoldPlugin(request.body),
  );
}
