import type { FastifyInstance } from 'fastify';
import type { ServerContext } from '../context.ts';
import { listBackups, restoreBackup, deleteBackup } from '../domains/backups.ts';

/**
 * Резервные копии: посмотреть и откатиться.
 *
 * Каталог копий существовал с самого начала, но был доступен только из
 * проводника. Откат — как раз то действие, ради которого копии и делаются,
 * поэтому ему место в панели.
 */
export function registerBackupRoutes(app: FastifyInstance, ctx: ServerContext): void {
  /** Пути, куда вообще разрешено восстанавливать: имя копии из запроса сюда не попадает. */
  const restorableTargets = (): Record<string, string> => {
    const { settings, settingsLocal, claudeMd, secretsEnv, mcpConfig } = ctx.location.paths;
    return { settings, settingsLocal, claudeMd, secretsEnv, mcpConfig };
  };

  app.get('/api/backups', () => ({
    // store.backupDir, а не ctx.backupDir: копии надо показывать и тогда,
    // когда пользователь выключил их создание, — старые никуда не делись.
    items: listBackups(ctx.store.backupDir, restorableTargets(), ctx.location.paths.skills),
    isEnabled: ctx.store.getSettings().backupBeforeWrite,
  }));

  app.post<{ Params: { name: string } }>('/api/backups/:name/restore', (request, reply) => {
    const result = restoreBackup(
      ctx.store.backupDir,
      decodeURIComponent(request.params.name),
      restorableTargets(),
      ctx.location.paths.skills,
    );

    if (!result.ok) return reply.code(400).send({ error: result.error });

    return { ...result, needsRestart: true };
  });

  app.delete<{ Params: { name: string } }>('/api/backups/:name', (request, reply) => {
    const removed = deleteBackup(ctx.store.backupDir, decodeURIComponent(request.params.name));
    if (!removed) return reply.code(404).send({ error: 'Копия не найдена' });

    return { ok: true };
  });
}
