import type { FastifyInstance } from 'fastify';
import type { HookDraft } from '@claude-control/contracts';
import type { ServerContext } from '../../context.ts';
import { readHooks, upsertHook, deleteHook, moveHook } from '../../domains/hooks.ts';
import { findHook, type EntityToggleDeps } from '../../domains/entity-toggle.ts';
import { stripLocalPrefix } from '../../lib/settings-source.ts';
import { done } from '../write-result.ts';
import { targetOf, type ClaudePaths } from './shared.ts';

/** Хуки: settings.json + settings.local.json, порядок внутри события правится здесь же. */
export function registerHookRoutes(app: FastifyInstance, ctx: ServerContext): void {
  const paths = (): ClaudePaths => ctx.location.paths;
  /** Поиск хука — доменная функция, ей нужны только пути и состояние панели. */
  const lookup = (): EntityToggleDeps => ({ paths: paths(), store: ctx.store });

  app.get('/api/hooks', () => readHooks(paths().settings, ctx.store, paths().settingsLocal));

  app.post<{ Body: HookDraft }>('/api/hooks', (request) =>
    done(upsertHook(paths().settings, paths().hooks, null, request.body, ctx.store, ctx.backupDir)),
  );

  app.put<{ Params: { id: string }; Body: HookDraft }>('/api/hooks/:id', (request) => {
    // Ссылка могла быть сохранена до перехода на контентные id — приводим.
    const id = findHook(lookup(), request.params.id)?.id ?? request.params.id;

    return done(
      upsertHook(
        paths().settings,
        paths().hooks,
        stripLocalPrefix(id),
        request.body,
        ctx.store,
        ctx.backupDir,
        targetOf(ctx, id),
      ),
    );
  });

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
  app.post<{ Params: { id: string }; Body: { direction: 'up' | 'down' } }>(
    '/api/hooks/:id/move',
    (request) => {
      const id = findHook(lookup(), request.params.id)?.id ?? request.params.id;
      return done(
        moveHook(
          paths().settings,
          ctx.store,
          id,
          request.body.direction === 'up' ? 'up' : 'down',
          ctx.backupDir,
          paths().settingsLocal,
        ),
      );
    },
  );
}
