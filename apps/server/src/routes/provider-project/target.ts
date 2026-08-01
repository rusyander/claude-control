import type { FastifyReply } from 'fastify';
import type { Project } from '@claude-control/contracts';
import type { ServerContext } from '../../context.ts';
import {
  resolveProviderProjectTarget,
  UnsafeProjectPathError,
  type ProviderProjectTarget,
} from '../../domains/provider-projects.ts';
import { checkProjectDir } from '../../domains/projects.ts';
import { SECTION_UNSUPPORTED } from './messages.ts';

/**
 * Проектная цель активного провайдера по id записи реестра. Undefined означает,
 * что ответ уже отправлен (404/400) — маршрут просто возвращает reply.
 */
export const requireTarget = (
  ctx: ServerContext,
  id: string,
  reply: FastifyReply,
): ProviderProjectTarget | undefined => {
  const project: Project | undefined = ctx.store.getProject(id);
  if (!project) {
    void reply.code(404).send({ error: 'not_found', message: 'Проект не найден в реестре' });
    return undefined;
  }

  // Каталог мог быть удалён/переименован уже после добавления в реестр —
  // проверяем перед каждой операцией, а не только при добавлении.
  const problem = checkProjectDir(project.path);
  if (problem) {
    void reply.code(400).send({ error: 'invalid_project', message: problem });
    return undefined;
  }

  try {
    const target = resolveProviderProjectTarget(ctx.store, project.path);
    if (!target) {
      void reply.code(400).send(SECTION_UNSUPPORTED);
      return undefined;
    }
    return target;
  } catch (error) {
    if (error instanceof UnsafeProjectPathError) {
      void reply.code(400).send({ error: 'unsafe_path', message: error.message });
      return undefined;
    }
    throw error;
  }
};

/** Разбор ошибки домена в ответ: код плюс тело; чужую ошибку домен не узнаёт. */
type DescribeError = (
  error: unknown,
) => { status: number; body: Record<string, unknown> } | undefined;

/**
 * Обёртка операции домена, раскладывающая его отказы в коды ответа. Правила,
 * плагины и скиллы устроены одинаково — различает их только `describe`,
 * разбирающая ошибки своего домена.
 */
export const guardedBy =
  (describe: DescribeError) =>
  <T>(reply: FastifyReply, run: () => T): T | FastifyReply => {
    try {
      return run();
    } catch (error) {
      const described = describe(error);
      if (!described) throw error;
      return reply.code(described.status).send(described.body);
    }
  };
