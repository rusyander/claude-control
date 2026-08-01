import type { FastifyInstance } from 'fastify';
import type { ServerContext } from '../../context.ts';
import {
  readProviderSkillsInfo,
  readProviderSkill,
  parseProviderSkillDraft,
  saveProviderSkill,
  deleteProviderSkill,
  describeSkillError,
} from '../../domains/provider-skills.ts';
import { done } from '../write-result.ts';
import { guardedBy, requireTarget } from './target.ts';
import { INVALID_SKILL_DRAFT, SKILLS_UNSUPPORTED } from './messages.ts';

/** Выполнить операцию домена скиллов, разложив её отказы в коды ответа. */
const guardedSkill = guardedBy(describeSkillError);

/**
 * Скиллы проекта: каталог `.opencode/skills` (OPENCODE-5).
 *
 * Тот же домен и та же защита путей, что у глобального каталога: корнем служит
 * уже проверенный каталог проекта, наружу него ни `..`, ни ссылка в сегменте,
 * ни путь иной формы, чем `<имя>/SKILL.md`, не выпускают.
 */
export function registerProviderProjectSkillsRoutes(
  app: FastifyInstance,
  ctx: ServerContext,
): void {
  app.get<{ Params: { id: string } }>('/api/projects/:id/provider/skills', (request, reply) => {
    const target = requireTarget(ctx, request.params.id, reply);
    if (!target) return reply;
    if (!target.skills) return reply.code(400).send(SKILLS_UNSUPPORTED);

    return readProviderSkillsInfo(target.skills);
  });

  app.get<{ Params: { id: string }; Querystring: { path?: string } }>(
    '/api/projects/:id/provider/skills/skill',
    (request, reply) => {
      const target = requireTarget(ctx, request.params.id, reply);
      if (!target) return reply;
      const skills = target.skills;
      if (!skills) return reply.code(400).send(SKILLS_UNSUPPORTED);

      const raw = request.query.path;
      if (typeof raw !== 'string' || !raw) return reply.code(400).send(INVALID_SKILL_DRAFT);

      return guardedSkill(reply, () => readProviderSkill(skills, raw));
    },
  );

  app.put<{ Params: { id: string }; Body: unknown }>(
    '/api/projects/:id/provider/skills/skill',
    (request, reply) => {
      const target = requireTarget(ctx, request.params.id, reply);
      if (!target) return reply;
      const skills = target.skills;
      if (!skills) return reply.code(400).send(SKILLS_UNSUPPORTED);

      const draft = parseProviderSkillDraft(request.body);
      if (!draft) return reply.code(400).send(INVALID_SKILL_DRAFT);

      return guardedSkill(reply, () => {
        const saved = saveProviderSkill(skills, draft, ctx.backupDir);
        return { ...done(saved.backupPath), path: saved.path, fullPath: saved.fullPath };
      });
    },
  );

  app.delete<{ Params: { id: string }; Querystring: { path?: string } }>(
    '/api/projects/:id/provider/skills/skill',
    (request, reply) => {
      const target = requireTarget(ctx, request.params.id, reply);
      if (!target) return reply;
      const skills = target.skills;
      if (!skills) return reply.code(400).send(SKILLS_UNSUPPORTED);

      const raw = request.query.path;
      if (typeof raw !== 'string' || !raw) return reply.code(400).send(INVALID_SKILL_DRAFT);

      return guardedSkill(reply, () => {
        const removed = deleteProviderSkill(skills, raw, ctx.backupDir);
        return { ...done(removed.backupPath), path: removed.path };
      });
    },
  );
}
