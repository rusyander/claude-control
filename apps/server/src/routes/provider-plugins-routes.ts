import type { FastifyInstance, FastifyReply } from 'fastify';
import type { ServerContext } from '../context.ts';
import {
  resolveProviderPluginsTarget,
  readProviderPluginsInfo,
  readProviderPluginFile,
  parseProviderPluginFileDraft,
  saveProviderPluginFile,
  deleteProviderPluginFile,
  parseProviderPluginPackagesDraft,
  saveProviderPluginPackages,
  describePluginError,
  type ProviderPluginsTarget,
} from '../domains/provider-plugins.ts';
import { UnrecognizedFormatError } from '../lib/format-errors.ts';

/**
 * Плагины НЕ-Claude провайдера (OPENCODE-4) — глобальный уровень.
 *
 * Claude сюда НЕ ходит: его раздел «Плагины» — расширения САМОЙ панели на
 * прежних маршрутах `/api/plugins`, он не тронут. Здесь — плагины CLI OpenCode:
 * каталог файлов JS/TS и массив npm-пакетов `plugin` в `opencode.json`.
 *
 * FAIL-CLOSED на каждом шаге:
 *  - провайдер без `pluginsConfig`/`plugins=ready` (включая claude) → 400
 *    `section_unsupported`;
 *  - путь вне каталога плагинов (`..`, абсолютный, UNC, чужое расширение, ссылка
 *    в сегменте) → 400 `unsafe_path` ВСЕГДА (не 404): существует ли что-то за
 *    пределами каталога, панель не сообщает. Одинаково на чтении, записи, удалении;
 *  - файла нет → 404 `not_found`; файл не текст или слишком большой → 422;
 *  - конфиг не разобран → GET отдаёт `packagesReadOnly:true`, PUT списка 422.
 */
export function registerProviderPluginsRoutes(app: FastifyInstance, ctx: ServerContext): void {
  const SECTION_UNSUPPORTED = {
    error: 'section_unsupported',
    message: 'У активного провайдера нет универсального раздела плагинов.',
  } as const;

  const INVALID_FILE_DRAFT = {
    error: 'invalid_draft',
    message:
      'Файл плагина не прошёл проверку: нужен путь внутри каталога плагинов (.js, .ts или .mjs) и текстовое содержимое.',
  } as const;

  const INVALID_PACKAGES_DRAFT = {
    error: 'invalid_draft',
    message:
      'Список npm-плагинов не прошёл проверку: каждое имя — непустая строка без пробелов и кавычек, повторы недопустимы.',
  } as const;

  const FORMAT_UNRECOGNIZED = {
    error: 'format_unrecognized',
    message:
      'Формат файла конфигурации не распознан — запись запрещена (список только для чтения).',
  } as const;

  const requireTarget = (reply: FastifyReply): ProviderPluginsTarget | undefined => {
    const target = resolveProviderPluginsTarget(ctx.store);
    if (!target) {
      void reply.code(400).send(SECTION_UNSUPPORTED);
      return undefined;
    }
    return target;
  };

  /**
   * Цель, в которую МОЖНО писать. У Kimi раздел показывает установленные
   * плагины и ничего не пишет: ставят и включают их командой `/plugins` внутри
   * CLI, а форма реестра `installed.json` не задокументирована. Ответ 409 (а не
   * 422): файл в порядке, запрещена сама операция.
   */
  const requireWritableTarget = (reply: FastifyReply): ProviderPluginsTarget | undefined => {
    const target = requireTarget(reply);
    if (!target) return undefined;
    if (target.format === 'kimi-plugins') {
      void reply.code(409).send({
        error: 'write_disabled',
        message:
          'Плагины Kimi Code панель только показывает: устанавливать, включать и выключать их нужно командой /plugins внутри CLI — форма реестра установленного не задокументирована.',
      });
      return undefined;
    }
    return target;
  };

  /** Выполнить операцию домена, разложив её отказы в коды ответа (fail-closed). */
  const guarded = <T>(reply: FastifyReply, run: () => T): T | FastifyReply => {
    try {
      return run();
    } catch (error) {
      const described = describePluginError(error);
      if (!described) throw error;
      return reply.code(described.status).send(described.body);
    }
  };

  app.get('/api/provider-plugins', (_request, reply) => {
    const target = requireTarget(reply);
    if (!target) return reply;
    return readProviderPluginsInfo(target);
  });

  // --- файлы плагинов ---

  app.get<{ Querystring: { path?: string } }>('/api/provider-plugins/file', (request, reply) => {
    const target = requireTarget(reply);
    if (!target) return reply;

    const raw = request.query.path;
    if (typeof raw !== 'string' || !raw) return reply.code(400).send(INVALID_FILE_DRAFT);

    return guarded(reply, () => readProviderPluginFile(target, raw));
  });

  app.put<{ Body: unknown }>('/api/provider-plugins/file', (request, reply) => {
    const target = requireWritableTarget(reply);
    if (!target) return reply;

    const draft = parseProviderPluginFileDraft(request.body);
    if (!draft) return reply.code(400).send(INVALID_FILE_DRAFT);

    return guarded(reply, () => {
      const saved = saveProviderPluginFile(target, draft, ctx.backupDir);
      return {
        ok: true as const,
        backupPath: saved.backupPath,
        needsRestart: true as const,
        path: saved.path,
        fullPath: saved.fullPath,
      };
    });
  });

  app.delete<{ Querystring: { path?: string } }>('/api/provider-plugins/file', (request, reply) => {
    const target = requireWritableTarget(reply);
    if (!target) return reply;

    const raw = request.query.path;
    if (typeof raw !== 'string' || !raw) return reply.code(400).send(INVALID_FILE_DRAFT);

    return guarded(reply, () => {
      const removed = deleteProviderPluginFile(target, raw, ctx.backupDir);
      return {
        ok: true as const,
        backupPath: removed.backupPath,
        needsRestart: true as const,
        path: removed.path,
      };
    });
  });

  // --- npm-пакеты (`plugin` в opencode.json) ---

  app.put<{ Body: unknown }>('/api/provider-plugins/packages', (request, reply) => {
    const target = requireWritableTarget(reply);
    if (!target) return reply;

    const packages = parseProviderPluginPackagesDraft(request.body);
    if (!packages) return reply.code(400).send(INVALID_PACKAGES_DRAFT);

    try {
      const backupPath = saveProviderPluginPackages(target, packages, ctx.backupDir);
      return { ok: true as const, backupPath, needsRestart: true as const };
    } catch (error) {
      if (error instanceof UnrecognizedFormatError) {
        return reply.code(422).send(FORMAT_UNRECOGNIZED);
      }
      throw error;
    }
  });
}
