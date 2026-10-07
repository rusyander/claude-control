import type { FastifyInstance } from 'fastify';
import type { ServerContext } from '../context.ts';
import type { PluginScaffoldRequest } from '@agentdeck/contracts';
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
import { attachTextCodes } from '../lib/server-texts.ts';
import { sectionGuard } from './provider-guard.ts';

/**
 * Маршруты плагинов. Каждая операция — вызов CLI, а он ходит в сеть и клонирует
 * репозитории, поэтому ответы приходят не мгновенно; интерфейс обязан показывать
 * ход выполнения, а не подвисать молча.
 */
export function registerPluginRoutes(app: FastifyInstance, ctx: ServerContext): void {
  // Всё, кроме скаффолдера, — команды `claude plugin …` и каталог плагинов Claude.
  // При другом активном CLI маршрут запустил бы ЕГО с аргументами Claude и
  // показал бы плагины Claude под чужим именем — отказываем до запуска.
  const claudePlugins = { preHandler: sectionGuard(ctx.store, 'panel-plugins') };

  // Заметка «список не получен» собрана строкой: код к ней восстанавливается
  // разбором, и английская страница читает её своим словарём.
  app.get('/api/plugins', claudePlugins, async () =>
    attachTextCodes(await readPlugins(ctx.location.paths.root, activeCliCommand(ctx.store)), [
      'notes',
    ]),
  );

  app.get('/api/plugins/available', claudePlugins, () =>
    readAvailablePlugins(activeCliCommand(ctx.store)),
  );

  app.post<{ Body: { id?: string } }>('/api/plugins/install', claudePlugins, (request, reply) => {
    // Без идентификатора установка ушла бы в CLI пустой строкой: он клонирует
    // репозитории и ходит в сеть, поэтому отказываем до запуска.
    if (!request.body.id)
      return reply
        .code(400)
        .send({ message: 'Не указан плагин', messageCode: 'plugin-unspecified' });

    return installPlugin(request.body.id, activeCliCommand(ctx.store));
  });

  app.post<{ Params: { id: string } }>('/api/plugins/:id/uninstall', claudePlugins, (request) =>
    uninstallPlugin(request.params.id, activeCliCommand(ctx.store)),
  );

  app.post<{ Params: { id: string }; Body: { isEnabled?: boolean } }>(
    '/api/plugins/:id/enabled',
    claudePlugins,
    (request, reply) => {
      // Состояние домысливать нельзя: пустое тело раньше означало «выключить».
      if (typeof request.body.isEnabled !== 'boolean') {
        return reply.code(400).send({
          message: 'Не указано состояние плагина',
          messageCode: 'plugin-state-unspecified',
        });
      }

      return request.body.isEnabled
        ? enablePlugin(request.params.id, activeCliCommand(ctx.store))
        : disablePlugin(request.params.id, activeCliCommand(ctx.store));
    },
  );

  app.post<{ Params: { id: string } }>('/api/plugins/:id/update', claudePlugins, (request) =>
    updatePlugin(request.params.id, activeCliCommand(ctx.store)),
  );

  // Маркетплейсы: раньше источник добавляли только командой claude в терминале.
  app.post<{ Body: { source?: string } }>(
    '/api/plugins/marketplaces',
    claudePlugins,
    (request, reply) => {
      if (!request.body.source)
        return reply
          .code(400)
          .send({ message: 'Не указан источник', messageCode: 'plugin-source-unspecified' });

      return addMarketplace(request.body.source, activeCliCommand(ctx.store));
    },
  );

  // Параметр уже раскодирован Fastify: второе раскодирование падало на «%» пятисоткой
  // и превращало присланное имя в другое.
  app.delete<{ Params: { name: string } }>(
    '/api/plugins/marketplaces/:name',
    claudePlugins,
    (request) => removeMarketplace(request.params.name, activeCliCommand(ctx.store)),
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
      return reply.code(400).send({
        ok: false,
        error: 'Не указан каталог или имя плагина',
        messageCode: 'plugin-dir-or-name-unspecified',
      });
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
