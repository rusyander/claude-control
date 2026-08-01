import type { FastifyInstance } from 'fastify';
import type { ServerContext } from '../../context.ts';
import {
  readProviderRulesInfo,
  readProviderRule,
  parseProviderRuleDraft,
  saveProviderRule,
  deleteProviderRule,
  describeRuleError,
} from '../../domains/provider-rules.ts';
import { done } from '../write-result.ts';
import { guardedBy, requireTarget } from './target.ts';
import { INSTRUCTIONS_RULES_UNSUPPORTED, INVALID_RULE_DRAFT } from './messages.ts';

/** Выполнить операцию домена правил, разложив её отказы в коды ответа. */
const guardedRule = guardedBy(describeRuleError);

/**
 * Правила проекта КАТАЛОГОМ `.mdc`: `<проект>/.cursor/rules` (CURSOR-1).
 *
 * Тот же домен, что и у глобального каталога; отличие одно — корень лежит в
 * проекте (и сам он уже проверен `resolveProjectFile` на выход за его пределы).
 */
export function registerProviderProjectRulesRoutes(app: FastifyInstance, ctx: ServerContext): void {
  app.get<{ Params: { id: string } }>('/api/projects/:id/provider/rules', (request, reply) => {
    const target = requireTarget(ctx, request.params.id, reply);
    if (!target) return reply;
    if (!target.instructionsRules) return reply.code(400).send(INSTRUCTIONS_RULES_UNSUPPORTED);

    return readProviderRulesInfo(target.instructionsRules);
  });

  app.get<{ Params: { id: string }; Querystring: { path?: string } }>(
    '/api/projects/:id/provider/rules/rule',
    (request, reply) => {
      const target = requireTarget(ctx, request.params.id, reply);
      if (!target) return reply;
      const rules = target.instructionsRules;
      if (!rules) return reply.code(400).send(INSTRUCTIONS_RULES_UNSUPPORTED);

      const raw = request.query.path;
      if (typeof raw !== 'string' || !raw) return reply.code(400).send(INVALID_RULE_DRAFT);

      return guardedRule(reply, () => readProviderRule(rules, raw));
    },
  );

  app.put<{ Params: { id: string }; Body: unknown }>(
    '/api/projects/:id/provider/rules/rule',
    (request, reply) => {
      const target = requireTarget(ctx, request.params.id, reply);
      if (!target) return reply;
      const rules = target.instructionsRules;
      if (!rules) return reply.code(400).send(INSTRUCTIONS_RULES_UNSUPPORTED);

      const draft = parseProviderRuleDraft(request.body);
      if (!draft) return reply.code(400).send(INVALID_RULE_DRAFT);

      return guardedRule(reply, () => {
        const saved = saveProviderRule(rules, draft, ctx.backupDir);
        return {
          ...done(saved.backupPath),
          path: saved.path,
          fullPath: saved.fullPath,
        };
      });
    },
  );

  app.delete<{ Params: { id: string }; Querystring: { path?: string } }>(
    '/api/projects/:id/provider/rules/rule',
    (request, reply) => {
      const target = requireTarget(ctx, request.params.id, reply);
      if (!target) return reply;
      const rules = target.instructionsRules;
      if (!rules) return reply.code(400).send(INSTRUCTIONS_RULES_UNSUPPORTED);

      const raw = request.query.path;
      if (typeof raw !== 'string' || !raw) return reply.code(400).send(INVALID_RULE_DRAFT);

      return guardedRule(reply, () => {
        const removed = deleteProviderRule(rules, raw, ctx.backupDir);
        return { ...done(removed.backupPath), path: removed.path };
      });
    },
  );
}
