import type { FastifyInstance } from 'fastify';
import type { ServerContext } from '../context.ts';
import {
  buildConfigBundle,
  parseConfigBundle,
  applyConfigBundle,
  type ImportBundleOptions,
  type RulesImportMode,
} from '../domains/config-bundle.ts';

/**
 * Экспорт и импорт бандла конфигурации: правила + скиллы + хуки одним файлом.
 * Отдельно от переноса state.json (`/api/settings/*`): там снимок панели, здесь —
 * реальные файлы Claude Code.
 */
export function registerConfigBundleRoutes(app: FastifyInstance, ctx: ServerContext): void {
  // Дату сборки берём из запроса, иначе — часы ОС. Домен её не выдумывает.
  app.get<{ Querystring: { exportedAt?: string } }>('/api/config-bundle/export', (request) => {
    const exportedAt = request.query.exportedAt?.trim() || new Date().toISOString();
    return buildConfigBundle(ctx.location.paths, exportedAt);
  });

  app.post<{ Body: unknown }>('/api/config-bundle/import', (request, reply) => {
    const body = request.body;
    // Тело: сам бандл, либо { bundle, options }. Опции влияют на правила
    // (append/replace/skip) и на перезапись существующих скиллов.
    const raw = isRecord(body) && 'bundle' in body ? body.bundle : body;
    const options = extractOptions(isRecord(body) ? body.options : undefined);

    try {
      const bundle = parseConfigBundle(raw);
      const summary = applyConfigBundle(ctx.location.paths, bundle, options, ctx.backupDir);
      return { ok: true, needsRestart: true, summary };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return reply.code(400).send({ error: 'invalid_bundle', message });
    }
  });
}

function extractOptions(value: unknown): ImportBundleOptions {
  if (!isRecord(value)) return {};
  const options: ImportBundleOptions = {};

  const mode = value.rulesMode;
  if (mode === 'append' || mode === 'replace' || mode === 'skip') {
    options.rulesMode = mode as RulesImportMode;
  }
  if (typeof value.overwriteSkills === 'boolean') options.overwriteSkills = value.overwriteSkills;

  return options;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
