import type { FastifyInstance, FastifyReply } from 'fastify';
import type { HookDraft } from '@claude-control/contracts';
import type { ServerContext } from '../../context.ts';
import { readHooks, upsertHook, deleteHook, moveHook } from '../../domains/hooks.ts';
import { findHook, type EntityToggleDeps } from '../../domains/entity-toggle.ts';
import { stripLocalPrefix } from '../../lib/settings-source.ts';
import { done } from '../write-result.ts';
import { targetOf, type ClaudePaths } from './shared.ts';

/**
 * Черновик хука приезжает из формы, но к серверу ходит ещё и телефон, и
 * оборванный запрос доходит сюда куском. Событие домыслить нечем — это и есть
 * «когда запускать», без него запись в settings.json бессмысленна; списки же
 * пустыми осмысленны (хук без фильтра ловит всё), поэтому их достаточно
 * привести к массиву, а не отказывать. Без этой проверки нехватка поля падала
 * пятисоткой в домене — снаружи «сломалась панель» вместо «не хватает поля».
 */
function hookDraft(body: Partial<HookDraft>): HookDraft | undefined {
  if (typeof body.event !== 'string' || !body.event) return undefined;

  return {
    ...body,
    event: body.event,
    matchers: Array.isArray(body.matchers) ? body.matchers : [],
    guardPatterns: Array.isArray(body.guardPatterns) ? body.guardPatterns : [],
    groupIds: Array.isArray(body.groupIds) ? body.groupIds : [],
    isEnabled: body.isEnabled !== false,
    command: typeof body.command === 'string' ? body.command : '',
  };
}

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
