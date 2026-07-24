import type { FastifyInstance, FastifyReply } from 'fastify';
import type { ServerContext } from '../context.ts';
import {
  resolveProviderRulesTarget,
  readProviderRulesInfo,
  readProviderRule,
  parseProviderRuleDraft,
  saveProviderRule,
  deleteProviderRule,
  describeRuleError,
  type ProviderRulesTarget,
} from '../domains/provider-rules.ts';

/**
 * Раздел инструкций в модели КАТАЛОГА ПРАВИЛ (CURSOR-1) — глобальный уровень.
 *
 * Claude/Codex/Gemini/OpenCode сюда НЕ ходят (у них один файл на прежнем
 * маршруте `/api/claude-md` — регресс-ноль), Aider тоже (у него список ссылок на
 * `/api/provider-instructions`). Здесь — Cursor: каталог `~/.cursor/rules` с
 * файлами `.mdc`, у каждого свой frontmatter.
 *
 * FAIL-CLOSED на каждом шаге:
 *  - провайдер без `instructionsRules` → 400 `section_unsupported`;
 *  - путь вне каталога правил (`..`, абсолютный, чужое расширение, ссылка в
 *    сегменте) → 400 `unsafe_path`, ничего не читается, не пишется, не удаляется;
 *  - правила нет → 404 `not_found`;
 *  - frontmatter не разобран → GET отдаёт правило с `readOnly:true`, PUT 422
 *    `rule_read_only` (файл не переписывается).
 */
export function registerProviderRulesRoutes(app: FastifyInstance, ctx: ServerContext): void {
  const SECTION_UNSUPPORTED = {
    error: 'section_unsupported',
    message: 'У активного провайдера инструкции не устроены каталогом правил.',
  } as const;

  const INVALID_DRAFT = {
    error: 'invalid_draft',
    message:
      'Правило не прошло проверку: нужен путь внутри каталога правил и текстовое тело; description и globs — однострочные, alwaysApply — булево.',
  } as const;

  const requireTarget = (reply: FastifyReply): ProviderRulesTarget | undefined => {
    const target = resolveProviderRulesTarget(ctx.store);
    if (!target) {
      void reply.code(400).send(SECTION_UNSUPPORTED);
      return undefined;
    }
    return target;
  };

  /** Выполнить операцию домена, разложив её отказы в коды ответа (fail-closed). */
  const guarded = <T>(reply: FastifyReply, run: () => T): T | FastifyReply => {
    try {
      return run();
    } catch (error) {
      const described = describeRuleError(error);
      if (!described) throw error;
      return reply.code(described.status).send(described.body);
    }
  };

  app.get('/api/provider-rules', (_request, reply) => {
    const target = requireTarget(reply);
    if (!target) return reply;
    return readProviderRulesInfo(target);
  });

  app.get<{ Querystring: { path?: string } }>('/api/provider-rules/rule', (request, reply) => {
    const target = requireTarget(reply);
    if (!target) return reply;

    const raw = request.query.path;
    if (typeof raw !== 'string' || !raw) return reply.code(400).send(INVALID_DRAFT);

    return guarded(reply, () => readProviderRule(target, raw));
  });

  app.put<{ Body: unknown }>('/api/provider-rules/rule', (request, reply) => {
    const target = requireTarget(reply);
    if (!target) return reply;

    const draft = parseProviderRuleDraft(request.body);
    if (!draft) return reply.code(400).send(INVALID_DRAFT);

    return guarded(reply, () => {
      const saved = saveProviderRule(target, draft, ctx.backupDir);
      return {
        ok: true as const,
        backupPath: saved.backupPath,
        needsRestart: true as const,
        path: saved.path,
        fullPath: saved.fullPath,
      };
    });
  });

  app.delete<{ Querystring: { path?: string } }>('/api/provider-rules/rule', (request, reply) => {
    const target = requireTarget(reply);
    if (!target) return reply;

    const raw = request.query.path;
    if (typeof raw !== 'string' || !raw) return reply.code(400).send(INVALID_DRAFT);

    return guarded(reply, () => {
      const removed = deleteProviderRule(target, raw, ctx.backupDir);
      return {
        ok: true as const,
        backupPath: removed.backupPath,
        needsRestart: true as const,
        path: removed.path,
      };
    });
  });
}
