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
import { activeCliCommand } from '../providers/cli.ts';

/**
 * Маршруты плагинов. Каждая операция — вызов CLI, а он ходит в сеть и клонирует
 * репозитории, поэтому ответы приходят не мгновенно; интерфейс обязан показывать
 * ход выполнения, а не подвисать молча.
 */
export function registerPluginRoutes(app: FastifyInstance, ctx: ServerContext): void {
  app.get('/api/plugins', () => readPlugins(ctx.location.paths.root, activeCliCommand(ctx.store)));

  app.get('/api/plugins/available', () => readAvailablePlugins(activeCliCommand(ctx.store)));

  app.post<{ Body: { id?: string } }>('/api/plugins/install', (request, reply) => {
    // Без идентификатора установка ушла бы в CLI пустой строкой: он клонирует
    // репозитории и ходит в сеть, поэтому отказываем до запуска.
    if (!request.body.id) return reply.code(400).send({ message: 'Не указан плагин' });

    return installPlugin(request.body.id, activeCliCommand(ctx.store));
  });

  app.post<{ Params: { id: string } }>('/api/plugins/:id/uninstall', (request) =>
    uninstallPlugin(request.params.id, activeCliCommand(ctx.store)),
  );

  app.post<{ Params: { id: string }; Body: { isEnabled?: boolean } }>(
    '/api/plugins/:id/enabled',
    (request, reply) => {
      // Состояние домысливать нельзя: пустое тело раньше означало «выключить».
      if (typeof request.body.isEnabled !== 'boolean') {
        return reply.code(400).send({ message: 'Не указано состояние плагина' });
      }

      return request.body.isEnabled
        ? enablePlugin(request.params.id, activeCliCommand(ctx.store))
        : disablePlugin(request.params.id, activeCliCommand(ctx.store));
    },
  );

  app.post<{ Params: { id: string } }>('/api/plugins/:id/update', (request) =>
    updatePlugin(request.params.id, activeCliCommand(ctx.store)),
  );

  // Маркетплейсы: раньше источник добавляли только командой claude в терминале.
  app.post<{ Body: { source?: string } }>('/api/plugins/marketplaces', (request, reply) => {
    if (!request.body.source) return reply.code(400).send({ message: 'Не указан источник' });

    return addMarketplace(request.body.source, activeCliCommand(ctx.store));
  });

  app.delete<{ Params: { name: string } }>('/api/plugins/marketplaces/:name', (request) =>
    removeMarketplace(decodeURIComponent(request.params.name), activeCliCommand(ctx.store)),
  );

  // Скаффолдер: пишет файлы в выбранный пользователем каталог (не в ~/.claude),
  // поэтому CLI не задействован — это обычная запись на диск с проверками пути.
  // Отказ (папка занята, плохое имя) отдаём полем ok=false, как и CLI-команды:
  // форма разбирает его сама и показывает причину, а не ловит сетевую ошибку.
  app.post<{ Body: Partial<PluginScaffoldRequest> }>('/api/plugins/scaffold', (request, reply) => {
    // Каталог и имя задаёт человек в форме, домыслить их нечем: без каталога
    // писать некуда, а без имени нечего называть папкой и манифестом. Обрезанное
    // тело падало пятисоткой в записи вместо честного отказа.
    if (!request.body.dir || !request.body.name) {
      return reply.code(400).send({ ok: false, error: 'Не указан каталог или имя плагина' });
    }

    return scaffoldPlugin({
      ...request.body,
      dir: request.body.dir,
      name: request.body.name,
      // Манифест и README пишутся всегда; необязательные части без явного
      // выбора не создаём — пустые папки в чужом каталоге хуже их отсутствия.
      components: {
        commands: false,
        agents: false,
        skills: false,
        hooks: false,
        ...request.body.components,
      },
    });
  });
}
