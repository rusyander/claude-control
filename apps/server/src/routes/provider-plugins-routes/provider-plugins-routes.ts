import type { FastifyInstance, FastifyReply } from 'fastify';
import type { ServerContext } from '../../context.ts';
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
  parseExtensionSource,
  withQwenEnabledState,
  installQwenExtension,
  setQwenExtensionEnabled,
  uninstallQwenExtension,
  createQwenCliRun,
  createCodexPluginRun,
  parseCodexPluginSelector,
  parseCodexMarketplaceSource,
  withCodexPluginState,
  installCodexPlugin,
  uninstallCodexPlugin,
  setCodexPluginEnabled,
  addCodexMarketplace,
  removeCodexMarketplace,
  upgradeCodexMarketplace,
  type PluginCliRun,
  type QwenCliRun,
  type ProviderPluginsTarget,
} from '../../domains/provider-plugins/provider-plugins.ts';
import { providerCliCommand } from '../../providers/cli/cli.ts';
import { UnrecognizedFormatError } from '../../lib/format-errors.ts';

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
 *
 * Расширения Qwen (MAP 25) — `/installed`: установить, включить, выключить,
 * удалить. Панель только зовёт `qwen extensions …` и передаёт его отказ словами
 * CLI; файлы каталога расширений по файловым маршрутам не пишутся (409).
 *
 * Плагины Codex — те же `/installed` (`id` = `имя@рынок`) плюс `/marketplaces`:
 * ставит, удаляет и подключает рынки `codex plugin … --json`; включение —
 * строка `enabled` в `[plugins."id"]` config.toml, с резервной копией.
 */
export interface ProviderPluginsRoutesDeps {
  /** Запуск `qwen extensions …` — в тестах подменяется, иначе настоящий CLI. */
  qwenRun?: (command: string) => QwenCliRun;
  /** Запуск `codex plugin …` — так же. */
  codexRun?: (command: string) => PluginCliRun;
}

export function registerProviderPluginsRoutes(
  app: FastifyInstance,
  ctx: ServerContext,
  deps: ProviderPluginsRoutesDeps = {},
): void {
  const qwenRunFor = (target: ProviderPluginsTarget): QwenCliRun =>
    (deps.qwenRun ?? createQwenCliRun)(providerCliCommand(target.provider));
  const codexRunFor = (target: ProviderPluginsTarget): PluginCliRun =>
    (deps.codexRun ?? createCodexPluginRun)(providerCliCommand(target.provider));

  const SECTION_UNSUPPORTED = {
    error: 'section_unsupported',
    message: 'У активного провайдера нет универсального раздела плагинов.',
    messageCode: 'plugins-section-unsupported',
  } as const;

  const INVALID_FILE_DRAFT = {
    error: 'invalid_draft',
    message:
      'Файл плагина не прошёл проверку: нужен путь внутри каталога плагинов (.js, .ts или .mjs) и текстовое содержимое.',
    messageCode: 'plugin-file-draft-invalid',
  } as const;

  const INVALID_PACKAGES_DRAFT = {
    error: 'invalid_draft',
    message:
      'Список npm-плагинов не прошёл проверку: каждое имя — непустая строка без пробелов и кавычек, повторы недопустимы.',
    messageCode: 'plugin-npm-list-invalid',
  } as const;

  const FORMAT_UNRECOGNIZED = {
    error: 'format_unrecognized',
    message:
      'Формат файла конфигурации не распознан — запись запрещена (список только для чтения).',
    messageCode: 'config-format-unrecognized-list-readonly',
  } as const;

  const INVALID_ACTION = {
    error: 'invalid_action',
    message: 'Действие над расширением — только enable или disable.',
    messageCode: 'installed-action-invalid',
  } as const;

  const QWEN_FILES_DISABLED = {
    error: 'write_disabled',
    message:
      'Расширения Qwen Code меняются только командами qwen extensions — файлы каталога расширений панель не пишет.',
    messageCode: 'qwen-extensions-files-readonly',
  } as const;

  const CODEX_FILES_DISABLED = {
    error: 'write_disabled',
    message:
      'Плагины Codex меняются только командами codex plugin — файлы кэша плагинов панель не пишет.',
    messageCode: 'codex-plugins-files-readonly',
  } as const;

  const MARKETPLACES_UNSUPPORTED = {
    error: 'write_disabled',
    message: 'У активного провайдера нет рынков плагинов.',
    messageCode: 'plugin-marketplaces-unsupported',
  } as const;

  const CODEX_TOGGLE_UNRECOGNIZED = {
    error: 'format_unrecognized',
    message:
      'Не нашлась таблица [plugins."имя@рынок"] в config.toml Codex — включение не записано, файл не тронут.',
    messageCode: 'codex-plugin-toggle-unrecognized',
  } as const;

  const INSTALLED_ACTIONS_UNSUPPORTED = {
    error: 'write_disabled',
    message: 'У активного провайдера панель не меняет установленные расширения.',
    messageCode: 'installed-actions-unsupported',
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
        messageCode: 'kimi-plugins-readonly',
      });
      return undefined;
    }
    if (target.format === 'qwen-extensions') {
      void reply.code(409).send(QWEN_FILES_DISABLED);
      return undefined;
    }
    if (target.format === 'codex-plugins') {
      void reply.code(409).send(CODEX_FILES_DISABLED);
      return undefined;
    }
    return target;
  };

  /** Цель с действиями над установленным — расширения Qwen и плагины Codex. */
  const requireExtensionsTarget = (reply: FastifyReply): ProviderPluginsTarget | undefined => {
    const target = requireTarget(reply);
    if (!target) return undefined;
    if (target.format !== 'qwen-extensions' && target.format !== 'codex-plugins') {
      void reply.code(409).send(INSTALLED_ACTIONS_UNSUPPORTED);
      return undefined;
    }
    return target;
  };

  /** Цель с рынками плагинов — только Codex. */
  const requireMarketplaceTarget = (reply: FastifyReply): ProviderPluginsTarget | undefined => {
    const target = requireTarget(reply);
    if (!target) return undefined;
    if (target.format !== 'codex-plugins') {
      void reply.code(409).send(MARKETPLACES_UNSUPPORTED);
      return undefined;
    }
    return target;
  };

  /** То же, что `guarded`, для асинхронной операции (запуск CLI). */
  const guardedAsync = async <T>(
    reply: FastifyReply,
    run: () => Promise<T>,
  ): Promise<T | FastifyReply> => {
    try {
      return await run();
    } catch (error) {
      if (error instanceof UnrecognizedFormatError) {
        return reply.code(422).send(CODEX_TOGGLE_UNRECOGNIZED);
      }
      const described = describePluginError(error);
      if (!described) throw error;
      return reply.code(described.status).send(described.body);
    }
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

  app.get('/api/provider-plugins', async (_request, reply) => {
    const target = requireTarget(reply);
    if (!target) return reply;
    const info = readProviderPluginsInfo(target);
    if (target.format === 'qwen-extensions') return withQwenEnabledState(info, qwenRunFor(target));
    if (target.format === 'codex-plugins') return withCodexPluginState(info, codexRunFor(target));
    return info;
  });

  // --- установленные расширения (Qwen: `qwen extensions …`) ---

  app.post<{ Body: unknown }>('/api/provider-plugins/installed', async (request, reply) => {
    const target = requireExtensionsTarget(reply);
    if (!target) return reply;
    return guardedAsync(reply, async () => {
      const raw = (request.body as { source?: unknown } | null)?.source;
      const output =
        target.format === 'codex-plugins'
          ? await installCodexPlugin(codexRunFor(target), parseCodexPluginSelector(raw))
          : await installQwenExtension(qwenRunFor(target), parseExtensionSource(raw));
      return { ok: true as const, output, needsRestart: true as const };
    });
  });

  app.post<{ Params: { name: string; action: string } }>(
    '/api/provider-plugins/installed/:name/:action',
    async (request, reply) => {
      const target = requireExtensionsTarget(reply);
      if (!target) return reply;
      const { name, action } = request.params;
      if (action !== 'enable' && action !== 'disable') {
        return reply.code(400).send(INVALID_ACTION);
      }
      return guardedAsync(reply, async () => {
        if (target.format === 'codex-plugins') {
          const backupPath = await setCodexPluginEnabled(
            target,
            codexRunFor(target),
            name,
            action === 'enable',
            ctx.backupDir,
          );
          return { ok: true as const, output: '', backupPath, needsRestart: true as const };
        }
        const output = await setQwenExtensionEnabled(
          target,
          qwenRunFor(target),
          name,
          action === 'enable',
        );
        return { ok: true as const, output, needsRestart: true as const };
      });
    },
  );

  app.delete<{ Params: { name: string } }>(
    '/api/provider-plugins/installed/:name',
    async (request, reply) => {
      const target = requireExtensionsTarget(reply);
      if (!target) return reply;
      return guardedAsync(reply, async () => {
        const output =
          target.format === 'codex-plugins'
            ? await uninstallCodexPlugin(target, codexRunFor(target), request.params.name)
            : await uninstallQwenExtension(target, qwenRunFor(target), request.params.name);
        return { ok: true as const, output, needsRestart: true as const };
      });
    },
  );

  // --- рынки плагинов (Codex: `codex plugin marketplace …`) ---

  app.post<{ Body: unknown }>('/api/provider-plugins/marketplaces', async (request, reply) => {
    const target = requireMarketplaceTarget(reply);
    if (!target) return reply;
    return guardedAsync(reply, async () => {
      const source = parseCodexMarketplaceSource(
        (request.body as { source?: unknown } | null)?.source,
      );
      const output = await addCodexMarketplace(codexRunFor(target), source);
      return { ok: true as const, output, needsRestart: false as const };
    });
  });

  app.post<{ Params: { name: string } }>(
    '/api/provider-plugins/marketplaces/:name/upgrade',
    async (request, reply) => {
      const target = requireMarketplaceTarget(reply);
      if (!target) return reply;
      return guardedAsync(reply, async () => {
        const output = await upgradeCodexMarketplace(codexRunFor(target), request.params.name);
        return { ok: true as const, output, needsRestart: false as const };
      });
    },
  );

  app.delete<{ Params: { name: string } }>(
    '/api/provider-plugins/marketplaces/:name',
    async (request, reply) => {
      const target = requireMarketplaceTarget(reply);
      if (!target) return reply;
      return guardedAsync(reply, async () => {
        const output = await removeCodexMarketplace(codexRunFor(target), request.params.name);
        return { ok: true as const, output, needsRestart: false as const };
      });
    },
  );

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
