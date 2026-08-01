import type { FastifyInstance } from 'fastify';
import type { PermissionDraft } from '@claude-control/contracts';
import type { ServerContext } from '../../context.ts';
import {
  readPermissions,
  savePermission,
  deletePermission,
  movePermission,
} from '../../domains/permissions.ts';
import { stripLocalPrefix } from '../../lib/settings-source.ts';
import { done } from '../write-result.ts';
import { targetOf, type ClaudePaths } from './shared.ts';

/** Правила доступа: settings.json + settings.local.json. */
export function registerPermissionRoutes(app: FastifyInstance, ctx: ServerContext): void {
  const paths = (): ClaudePaths => ctx.location.paths;

  app.get('/api/permissions', () =>
    readPermissions(paths().settings, ctx.store, paths().settingsLocal),
  );

  app.post<{ Body: PermissionDraft }>('/api/permissions', (request) =>
    done(savePermission(paths().settings, null, request.body, ctx.backupDir)),
  );

  app.put<{ Params: { id: string }; Body: PermissionDraft }>('/api/permissions/:id', (request) => {
    const { id } = request.params;

    return done(
      savePermission(targetOf(ctx, id).path, stripLocalPrefix(id), request.body, ctx.backupDir),
    );
  });

  app.delete<{ Params: { id: string } }>('/api/permissions/:id', (request) => {
    const { id } = request.params;

    const backupPath = deletePermission(
      targetOf(ctx, id).path,
      stripLocalPrefix(id),
      ctx.backupDir,
    );
    // Отметки и состав групп ключуются id в том виде, в каком он пришёл (с
    // префиксом `local:`, если право из settings.local.json) — снимаем его же.
    ctx.store.removeEntity('permission', id);

    return done(backupPath);
  });

  // Перенос права в противоположный файл: из settings.json в settings.local.json
  // и обратно. Файл-источник определяется префиксом id (см. targetOf/isLocalId).
  app.post<{ Params: { id: string } }>('/api/permissions/:id/move', (request) =>
    done(movePermission(paths().settings, paths().settingsLocal, request.params.id, ctx.backupDir)),
  );
}
