import type { Project } from '@claude-control/contracts';
import type { ServerContext } from '../context.ts';
import { getActiveProvider } from '../providers/registry.ts';

/**
 * Минимум от `reply`, который нужен, чтобы отправить ошибку. Так помощник не
 * зависит от дженериков Fastify и одинаково подходит любому обработчику.
 */
export interface ErrorReply {
  code: (status: number) => { send: (body: unknown) => unknown };
}

/**
 * Fail-closed по провайдеру (COMMON-2): проектные маршруты Claude читают и
 * пишут файлы ПРОЕКТНОГО УРОВНЯ CLAUDE (CLAUDE.md, .claude/*, .mcp.json).
 * Активен другой провайдер → 400: его проектные файлы обслуживает
 * `/api/projects/:id/provider/*`, а конфиг Claude панель трогать не должна.
 * Возвращает true, если Claude активен; иначе ответ уже отправлен.
 */
export function requireClaudeProvider(ctx: ServerContext, reply: ErrorReply): boolean {
  if (getActiveProvider(ctx.store).id === 'claude') return true;
  reply.code(400).send({
    error: 'section_unsupported',
    message: 'Проектные файлы Claude доступны только при активном провайдере Claude.',
  });
  return false;
}

/**
 * Запись реестра по id или 404-ответ. Возвращает undefined, отправив ответ.
 * Гейт провайдера идёт первым: при активном Claude поведение прежнее.
 */
export function requireProject(
  ctx: ServerContext,
  id: string,
  reply: ErrorReply,
): Project | undefined {
  if (!requireClaudeProvider(ctx, reply)) return undefined;

  const project = ctx.store.getProject(id);
  if (!project) {
    reply.code(404).send({ error: 'not_found', message: 'Проект не найден в реестре' });
    return undefined;
  }
  return project;
}
