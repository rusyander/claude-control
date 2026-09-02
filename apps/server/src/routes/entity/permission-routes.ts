import type { FastifyInstance } from 'fastify';
import type { PermissionDraft } from '@claude-control/contracts';
import type { ServerContext } from '../../context.ts';
import {
  readPermissions,
  savePermission,
  deletePermission,
  movePermission,
  assertPermissionDraft,
  hasPermission,
  PermissionExistsError,
  PermissionNotFoundError,
} from '../../domains/permissions.ts';
import { LOCAL_ID_PREFIX, isLocalId, stripLocalPrefix } from '../../lib/settings-source.ts';
import { done } from '../write-result.ts';
import { targetOf, type ClaudePaths } from './shared.ts';

/** Правила доступа: settings.json + settings.local.json. */
export function registerPermissionRoutes(app: FastifyInstance, ctx: ServerContext): void {
  const paths = (): ClaudePaths => ctx.location.paths;

  app.get('/api/permissions', () =>
    readPermissions(paths().settings, ctx.store, paths().settingsLocal),
  );

  app.post<{ Body: PermissionDraft }>('/api/permissions', (request) => {
    const draft = assertPermissionDraft(request.body);
    // Дубль в том же файле не записывается: файл бы не изменился, а панель
    // показала бы «Создано». Пакетный ввод такую строку помечает отклонённой.
    if (hasPermission(paths().settings, `${draft.decision}:${draft.pattern}`)) {
      throw new PermissionExistsError(draft.pattern);
    }

    return done(savePermission(paths().settings, null, draft, ctx.backupDir));
  });

  app.put<{ Params: { id: string }; Body: PermissionDraft }>('/api/permissions/:id', (request) => {
    const { id } = request.params;
    const draft = assertPermissionDraft(request.body);
    const bareId = stripLocalPrefix(id);
    const target = targetOf(ctx, id).path;
    if (!hasPermission(target, bareId)) throw new PermissionNotFoundError(id);

    const backupPath = savePermission(target, bareId, draft, ctx.backupDir);
    // Идентификатор права — решение и шаблон, правка его меняет. Отметки и
    // состав групп ключуются им: переносим, иначе группа теряла участника, а в
    // state.json оставался призрак.
    const newId = `${isLocalId(id) ? LOCAL_ID_PREFIX : ''}${draft.decision}:${draft.pattern}`;
    if (newId !== id) ctx.store.renameEntity('permission', id, newId);

    return done(backupPath);
  });

  app.delete<{ Params: { id: string } }>('/api/permissions/:id', (request) => {
    const { id } = request.params;
    const bareId = stripLocalPrefix(id);
    const target = targetOf(ctx, id).path;
    if (!hasPermission(target, bareId)) throw new PermissionNotFoundError(id);

    const backupPath = deletePermission(target, bareId, ctx.backupDir);
    // Отметки и состав групп ключуются id в том виде, в каком он пришёл (с
    // префиксом `local:`, если право из settings.local.json) — снимаем его же.
    ctx.store.removeEntity('permission', id);

    return done(backupPath);
  });

  // Перенос права в противоположный файл: из settings.json в settings.local.json
  // и обратно. Файл-источник определяется префиксом id (см. targetOf/isLocalId).
  app.post<{ Params: { id: string } }>('/api/permissions/:id/move', (request) => {
    const { id } = request.params;
    const bareId = stripLocalPrefix(id);
    if (!hasPermission(targetOf(ctx, id).path, bareId)) throw new PermissionNotFoundError(id);

    const backupPath = movePermission(
      paths().settings,
      paths().settingsLocal,
      id,
      ctx.backupDir,
    );
    // Перенос меняет префикс id — участие в группах и отметки едут следом.
    ctx.store.renameEntity('permission', id, isLocalId(id) ? bareId : `${LOCAL_ID_PREFIX}${bareId}`);

    return done(backupPath);
  });
}
