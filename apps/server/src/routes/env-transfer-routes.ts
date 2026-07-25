import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import type { FastifyInstance, FastifyReply } from 'fastify';
import type { ServerContext } from '../context.ts';
import { getProvider, isKnownProviderId } from '../providers/registry.ts';
import type { ConfigProvider } from '../providers/types.ts';
import { collectProviderFiles } from '../domains/env-transfer/collect.ts';
import {
  archiveFileName,
  buildEnvironmentArchive,
  parseEnvironmentArchive,
} from '../domains/env-transfer/archive.ts';
import { applyEnvironmentImport, planEnvironmentImport } from '../domains/env-transfer/import.ts';
import { providerLocations } from '../domains/env-transfer/locations.ts';

/**
 * Перенос окружения: конфигурация ЛЮБОГО провайдера уезжает одним zip и
 * разворачивается на другой машине.
 *
 * Три свойства, ради которых это отдельный раздел, а не расширение бандла
 * конфигурации (тот умеет только правила + скиллы + хуки Claude):
 *   - работает для всех провайдеров по их же объявлениям в каталоге;
 *   - секреты не переносятся вовсе — вместо них чек-лист «что ввести руками»;
 *   - импорт сначала показывает план (новое / такое же / отличается), пишет
 *     только отмеченное и каждую перезапись кладёт в резервную копию.
 *
 * Файл архива пишется на диск в выбранный пользователем каталог, а не отдаётся
 * потоком в браузер: пользователю нужен путь, по которому архив можно найти,
 * а браузер положил бы его в «Загрузки» под своим именем.
 */
export function registerEnvTransferRoutes(app: FastifyInstance, ctx: ServerContext): void {
  const override = (): string | undefined => ctx.store.getSettings().claudeDirOverride;

  const requireProvider = (id: unknown, reply: FastifyReply): ConfigProvider | undefined => {
    if (typeof id !== 'string' || !isKnownProviderId(id)) {
      void reply.code(400).send({
        error: 'unknown_provider',
        message: 'Не указан известный провайдер.',
      });
      return undefined;
    }
    return getProvider(id);
  };

  const fail = (reply: FastifyReply, error: unknown): FastifyReply => {
    const message = error instanceof Error ? error.message : String(error);
    const code = (error as { code?: string }).code === 'invalid_archive' ? 400 : 500;
    return reply.code(code).send({ error: 'invalid_archive', message });
  };

  /** Что попадёт в архив — до выбора папки, чтобы пользователь видел объём и чек-лист. */
  app.get<{ Querystring: { provider?: string } }>('/api/env-transfer/preview', (request, reply) => {
    const provider = requireProvider(request.query.provider, reply);
    if (!provider) return reply;

    const collected = collectProviderFiles(provider, override());
    return {
      provider: { id: provider.id, name: provider.name },
      locations: providerLocations(provider, override()).map((location) => ({
        index: location.index,
        kind: location.kind,
        role: location.role,
        path: location.path,
        exists: existsSync(location.path),
      })),
      files: collected.files.length,
      bytes: collected.totalBytes,
      skipped: collected.skipped,
      checklist: collected.checklist,
    };
  });

  app.post<{ Body: { provider?: string; targetDir?: string; exportedAt?: string } }>(
    '/api/env-transfer/export',
    (request, reply) => {
      const body = request.body ?? {};
      const provider = requireProvider(body.provider, reply);
      if (!provider) return reply;

      const targetDir = body.targetDir;
      if (typeof targetDir !== 'string' || !targetDir || !isAbsolute(targetDir)) {
        return reply
          .code(400)
          .send({ error: 'invalid_target', message: 'Нужен абсолютный путь к папке.' });
      }
      if (!existsSync(targetDir) || !statSync(targetDir).isDirectory()) {
        return reply
          .code(400)
          .send({ error: 'invalid_target', message: 'Такой папки нет на диске.' });
      }

      const exportedAt = body.exportedAt?.trim() || new Date().toISOString();
      try {
        const built = buildEnvironmentArchive(provider, exportedAt, override());
        const path = uniquePath(targetDir, archiveFileName(provider.id, exportedAt));
        writeFileSync(path, built.zip);

        return {
          ok: true,
          path,
          bytes: built.zip.length,
          files: built.manifest.entries.length,
          skipped: built.manifest.skipped,
          checklist: built.manifest.checklist,
        };
      } catch (error) {
        return fail(reply, error);
      }
    },
  );

  app.post<{ Body: { provider?: string; archivePath?: string } }>(
    '/api/env-transfer/import/plan',
    (request, reply) => {
      const body = request.body ?? {};
      const provider = requireProvider(body.provider, reply);
      if (!provider) return reply;

      const zip = readArchive(body.archivePath, reply);
      if (!zip) return reply;

      try {
        return planEnvironmentImport(parseEnvironmentArchive(zip), provider, override());
      } catch (error) {
        return fail(reply, error);
      }
    },
  );

  app.post<{ Body: { provider?: string; archivePath?: string; selection?: unknown } }>(
    '/api/env-transfer/import/apply',
    (request, reply) => {
      const body = request.body ?? {};
      const provider = requireProvider(body.provider, reply);
      if (!provider) return reply;

      const selection = Array.isArray(body.selection)
        ? body.selection.filter((item): item is string => typeof item === 'string')
        : [];
      if (selection.length === 0) {
        return reply
          .code(400)
          .send({ error: 'empty_selection', message: 'Не отмечено ни одной записи.' });
      }

      const zip = readArchive(body.archivePath, reply);
      if (!zip) return reply;

      try {
        const parsed = parseEnvironmentArchive(zip);
        const summary = applyEnvironmentImport(parsed, provider, {
          selection,
          override: override(),
          backupDir: ctx.backupDir,
        });
        return { ok: true, needsRestart: true, summary };
      } catch (error) {
        return fail(reply, error);
      }
    },
  );

  /** Читает архив с диска. Путь приходит из обзора файловой системы панели. */
  function readArchive(path: unknown, reply: FastifyReply): Buffer | undefined {
    if (typeof path !== 'string' || !path || !isAbsolute(path)) {
      void reply
        .code(400)
        .send({ error: 'invalid_archive', message: 'Нужен абсолютный путь к архиву.' });
      return undefined;
    }
    try {
      if (!statSync(path).isFile()) throw new Error('не файл');
      return readFileSync(path);
    } catch {
      void reply.code(400).send({ error: 'invalid_archive', message: 'Архив недоступен.' });
      return undefined;
    }
  }
}

/** Свободное имя в папке: если такой архив уже есть, добавляем номер. */
function uniquePath(dir: string, fileName: string): string {
  const candidate = join(dir, fileName);
  if (!existsSync(candidate)) return candidate;

  const dot = fileName.lastIndexOf('.');
  const base = dot > 0 ? fileName.slice(0, dot) : fileName;
  const extension = dot > 0 ? fileName.slice(dot) : '';
  for (let index = 2; index < 1000; index += 1) {
    const next = join(dir, `${base}-${index}${extension}`);
    if (!existsSync(next)) return next;
  }
  throw Object.assign(new Error('В папке слишком много архивов с таким именем.'), {
    code: 'invalid_archive',
  });
}
