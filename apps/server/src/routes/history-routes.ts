import type { FastifyInstance } from 'fastify';
import type { ServerContext } from '../context.ts';
import { buildDiff, buildHistory, revertHunk } from '../domains/history.ts';

/**
 * История изменений конфигурации: лента правок и полный дифф отдельной копии.
 *
 * Читающие маршруты без побочных эффектов — как поиск. Разбираются только копии
 * известных файлов конфигурации; имя копии из запроса за пределы каталога не
 * уводит (проверка в домене). Файл секретов .mcp-secrets.env в разрешённые
 * цели НЕ входит: его построчный дифф раскрыл бы значения токенов в интерфейсе.
 */
export function registerHistoryRoutes(app: FastifyInstance, ctx: ServerContext): void {
  /** Файлы, чьи изменения показываем. Секреты исключены намеренно. */
  const trackedTargets = (): Record<string, string> => {
    const { settings, settingsLocal, claudeMd, mcpConfig } = ctx.location.paths;
    return { settings, settingsLocal, claudeMd, mcpConfig };
  };

  // store.backupDir, а не ctx.backupDir: историю показываем и тогда, когда
  // создание копий выключено, — старые копии никуда не делись.
  app.get('/api/history', () => ({
    items: buildHistory(ctx.store.backupDir, trackedTargets()),
  }));

  app.get<{ Querystring: { name?: string } }>('/api/history/diff', (request, reply) => {
    const name = request.query.name;
    if (!name) return reply.code(400).send({ error: 'Не указана копия' });

    const diff = buildDiff(ctx.store.backupDir, name, trackedTargets());
    if (!diff) return reply.code(404).send({ error: 'Копия не найдена' });

    return diff;
  });

  /**
   * Выборочный откат: вернуть ОДИН ханк из копии в текущий файл. Пишущий
   * маршрут — в отличие от чтений выше. Цели те же (секреты исключены), имя
   * копии проверяется в домене. Копию «состояния до» кладём в ctx.backupDir —
   * тот же каталог, что и прочие правки (если копии не выключены).
   */
  app.post<{ Body: { name?: string; hunk?: number } }>(
    '/api/history/revert-hunk',
    (request, reply) => {
      const { name, hunk } = request.body;
      if (!name || typeof hunk !== 'number' || !Number.isInteger(hunk) || hunk < 0) {
        return reply.code(400).send({ error: 'Не указан ханк для отката' });
      }

      const result = revertHunk(ctx.store.backupDir, name, hunk, trackedTargets(), ctx.backupDir);
      if (!result.ok) return reply.code(400).send({ error: result.error });

      return { ...result, needsRestart: true };
    },
  );
}
