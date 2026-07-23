import type { FastifyInstance } from 'fastify';
import type { ServerContext } from '../context.ts';
import { listBackups, restoreBackup, deleteBackup } from '../domains/backups.ts';
import { setSecretPassphrase, hasSecretPassphrase } from '../lib/safe-io.ts';
import { makeVerifier, verifyPassphrase } from '../lib/secret-crypto.ts';

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
    // Шифрование копий секретов: включено ли, введена ли фраза в этой сессии и
    // настраивалось ли шифрование вообще (есть verifier). По этим флагам
    // интерфейс решает, спросить ли фразу перед восстановлением/включением.
    encryptSecrets: ctx.store.getSettings().encryptSecretBackups,
    passphraseLoaded: hasSecretPassphrase(),
    hasPassphrase: Boolean(ctx.store.getSecretBackupVerifier()),
  }));

  /**
   * Задать парольную фразу шифрования копий секретов на эту сессию.
   *
   * Фраза НЕ хранится: в state.json ложится только verifier (проверочная
   * производная). Первый ввод создаёт verifier; последующие сверяются с ним,
   * чтобы случайной опечаткой не завести вторую фразу — тогда старые и новые
   * копии шифровались бы разными ключами. `enable` заодно включает режим.
   */
  app.post<{ Body: { passphrase?: string; enable?: boolean } }>(
    '/api/backups/secret-passphrase',
    (request, reply) => {
      const passphrase = request.body.passphrase ?? '';
      if (passphrase.length < 8) {
        return reply.code(400).send({ error: 'Парольная фраза должна быть не короче 8 символов' });
      }

      const verifier = ctx.store.getSecretBackupVerifier();
      if (verifier) {
        if (!verifyPassphrase(passphrase, verifier)) {
          return reply.code(400).send({ error: 'Неверная парольная фраза' });
        }
      } else {
        ctx.store.setSecretBackupVerifier(makeVerifier(passphrase));
      }

      setSecretPassphrase(passphrase);
      if (request.body.enable) ctx.store.updateSettings({ encryptSecretBackups: true });

      return { ok: true, encryptSecrets: ctx.store.getSettings().encryptSecretBackups };
    },
  );

  app.post<{ Params: { name: string }; Body: { passphrase?: string } }>(
    '/api/backups/:name/restore',
    (request, reply) => {
      const result = restoreBackup(
        ctx.store.backupDir,
        decodeURIComponent(request.params.name),
        restorableTargets(),
        ctx.location.paths.skills,
        request.body?.passphrase,
      );

      if (!result.ok) return reply.code(400).send({ error: result.error });

      return { ...result, needsRestart: true };
    },
  );

  app.delete<{ Params: { name: string } }>('/api/backups/:name', (request, reply) => {
    const removed = deleteBackup(ctx.store.backupDir, decodeURIComponent(request.params.name));
    if (!removed) return reply.code(404).send({ error: 'Копия не найдена' });

    return { ok: true };
  });
}
