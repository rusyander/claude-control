import type { FastifyInstance, FastifyReply } from 'fastify';
import type { ServerContext } from '../context.ts';
import {
  resolveProviderSkillsTarget,
  readProviderSkillsInfo,
  readProviderSkill,
  parseProviderSkillDraft,
  saveProviderSkill,
  deleteProviderSkill,
  describeSkillError,
  type ProviderSkillsTarget,
} from '../domains/provider-skills.ts';

/**
 * Скиллы НЕ-Claude провайдера (OPENCODE-5) — глобальный уровень.
 *
 * Claude сюда НЕ ходит: его раздел скиллов остаётся на прежних маршрутах
 * `/api/skills` со своей моделью (включение переносом в `skills-disabled/`,
 * группы, файлы скилла). Здесь — каталог скиллов CLI OpenCode:
 * `<каталог>/<имя>/SKILL.md`.
 *
 * FAIL-CLOSED на каждом шаге:
 *  - провайдер без `skillsConfig`/`skills=ready` (включая claude) → 400
 *    `section_unsupported`;
 *  - путь не формы `<имя>/SKILL.md` либо выводящий за каталог (`..`, абсолютный,
 *    UNC, ссылка в сегменте) → 400 `unsafe_path` ВСЕГДА (не 404): существует ли
 *    что-то за пределами каталога, панель не сообщает. Одинаково на чтении,
 *    записи и удалении;
 *  - черновик нарушает правила имени/описания → 400 `invalid_draft` ДО записи;
 *  - скилла нет → 404 `not_found`;
 *  - шапка не разобрана → GET отдаёт скилл с `readOnly:true`, PUT 422
 *    `skill_read_only` (файл байт-в-байт прежний).
 */
export function registerProviderSkillsRoutes(app: FastifyInstance, ctx: ServerContext): void {
  const SECTION_UNSUPPORTED = {
    error: 'section_unsupported',
    message: 'У активного провайдера нет универсального раздела скиллов.',
  } as const;

  const INVALID_DRAFT = {
    error: 'invalid_draft',
    message:
      'Скилл не прошёл проверку: нужен путь вида «<имя>/SKILL.md», однострочные имя и описание и текстовое тело.',
  } as const;

  const requireTarget = (reply: FastifyReply): ProviderSkillsTarget | undefined => {
    const target = resolveProviderSkillsTarget(ctx.store);
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
      const described = describeSkillError(error);
      if (!described) throw error;
      return reply.code(described.status).send(described.body);
    }
  };

  app.get('/api/provider-skills', (_request, reply) => {
    const target = requireTarget(reply);
    if (!target) return reply;
    return readProviderSkillsInfo(target);
  });

  app.get<{ Querystring: { path?: string } }>('/api/provider-skills/skill', (request, reply) => {
    const target = requireTarget(reply);
    if (!target) return reply;

    const raw = request.query.path;
    if (typeof raw !== 'string' || !raw) return reply.code(400).send(INVALID_DRAFT);

    return guarded(reply, () => readProviderSkill(target, raw));
  });

  app.put<{ Body: unknown }>('/api/provider-skills/skill', (request, reply) => {
    const target = requireTarget(reply);
    if (!target) return reply;

    const draft = parseProviderSkillDraft(request.body);
    if (!draft) return reply.code(400).send(INVALID_DRAFT);

    return guarded(reply, () => {
      const saved = saveProviderSkill(target, draft, ctx.backupDir);
      return {
        ok: true as const,
        backupPath: saved.backupPath,
        needsRestart: true as const,
        path: saved.path,
        fullPath: saved.fullPath,
      };
    });
  });

  app.delete<{ Querystring: { path?: string } }>('/api/provider-skills/skill', (request, reply) => {
    const target = requireTarget(reply);
    if (!target) return reply;

    const raw = request.query.path;
    if (typeof raw !== 'string' || !raw) return reply.code(400).send(INVALID_DRAFT);

    return guarded(reply, () => {
      const removed = deleteProviderSkill(target, raw, ctx.backupDir);
      return {
        ok: true as const,
        backupPath: removed.backupPath,
        needsRestart: true as const,
        path: removed.path,
      };
    });
  });
}
