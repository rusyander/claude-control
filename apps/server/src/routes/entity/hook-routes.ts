import type { FastifyInstance, FastifyReply } from 'fastify';
import type { HookDraft } from '@agentdeck/contracts';
import type { ServerContext } from '../../context.ts';
import {
  readHooks,
  upsertHook,
  deleteHook,
  moveHook,
  normalizeHookDraft as hookDraft,
} from '../../domains/hooks.ts';
import { findHook, type EntityToggleDeps } from '../../domains/entity-toggle.ts';
import { stripLocalPrefix } from '../../lib/settings-source.ts';
import { done } from '../write-result.ts';
import { targetOf, type ClaudePaths } from './shared.ts';

const NO_EVENT = { message: 'Не указано событие хука' } as const;

const noEvent = (reply: FastifyReply): FastifyReply => reply.code(400).send(NO_EVENT);

/** Хуки: settings.json + settings.local.json, порядок внутри события правится здесь же. */
export function registerHookRoutes(app: FastifyInstance, ctx: ServerContext): void {
  const paths = (): ClaudePaths => ctx.location.paths;
  /** Поиск хука — доменная функция, ей нужны только пути и состояние панели. */
  const lookup = (): EntityToggleDeps => ({ paths: paths(), store: ctx.store });

  app.get('/api/hooks', () => readHooks(paths().settings, ctx.store, paths().settingsLocal));

  app.post<{ Body: Partial<HookDraft> }>('/api/hooks', (request, reply) => {
    const draft = hookDraft(request.body);
    if (!draft) return noEvent(reply);

    return done(upsertHook(paths().settings, paths().hooks, null, draft, ctx.store, ctx.backupDir));
  });

  app.put<{ Params: { id: string }; Body: Partial<HookDraft> }>(
    '/api/hooks/:id',
    (request, reply) => {
      const draft = hookDraft(request.body);
      if (!draft) return noEvent(reply);

      // Ссылка могла быть сохранена до перехода на контентные id — приводим.
      const id = findHook(lookup(), request.params.id)?.id ?? request.params.id;

      return done(
        upsertHook(
          paths().settings,
          paths().hooks,
          stripLocalPrefix(id),
          draft,
          ctx.store,
          ctx.backupDir,
          targetOf(ctx, id),
        ),
      );
    },
  );

  app.delete<{ Params: { id: string } }>('/api/hooks/:id', (request) => {
    const hook = findHook(lookup(), request.params.id);
    const id = hook?.id ?? request.params.id;

    const backupPath = deleteHook(
      paths().settings,
      id,
      ctx.store,
      ctx.backupDir,
      targetOf(ctx, id),
    );
    // Удалённый хук не должен остаться призраком в составе групп и в отметках:
    // иначе группа считает участника, которого нет, а новый хук с тем же
    // содержимым (тот же контентный id) молча унаследовал бы его группы.
    // Прежний, позиционный id снимаем тоже — по нему отметки могли лечь раньше.
    ctx.store.removeEntity('hook', id);
    if (hook?.legacyId) ctx.store.removeEntity('hook', hook.legacyId);

    return done(backupPath);
  });

  // Порядок хуков внутри одного события: раньше он равнялся порядку в файле,
  // переставить из панели было нельзя.
  app.post<{ Params: { id: string }; Body: { direction?: 'up' | 'down' } }>(
    '/api/hooks/:id/move',
    (request, reply) => {
      // Направление домысливать нельзя: раньше любое неизвестное значение
      // означало «вниз», то есть оборванный запрос молча переставлял хук.
      const direction = request.body.direction;
      if (direction !== 'up' && direction !== 'down') {
        return reply.code(400).send({ message: 'Не указано направление' });
      }

      const id = findHook(lookup(), request.params.id)?.id ?? request.params.id;
      return done(
        moveHook(paths().settings, ctx.store, id, direction, ctx.backupDir, paths().settingsLocal),
      );
    },
  );
}
