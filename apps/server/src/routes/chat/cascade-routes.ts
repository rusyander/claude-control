import { resolve } from 'node:path';
import type { FastifyInstance } from 'fastify';
import type { ServerContext } from '../../context.ts';
import { cascadeProjectKey, isCascadeEnabled } from '../../domains/model-cascade.ts';
import { readLoweredRuns, summarizeLoweredRuns } from '../../domains/chat/lowered-journal.ts';

/**
 * Правило «Подбирать модель под задачу» — чтение и запись положения тумблера.
 *
 * Тумблер стоит в меню чата рядом с правами, а помнится на проект: см.
 * `domains/model-cascade.ts`. Отдельный маршрут, а не поле настроек, именно
 * поэтому — у настроек панели нет проектной области, а заводить её ради одного
 * тумблера значило бы переписать схему, которую читают ещё телефон и импорт
 * снимка.
 */
export function registerChatCascadeRoutes(app: FastifyInstance, ctx: ServerContext): void {
  app.get<{ Querystring: { path?: string } }>('/api/chat/cascade', (request) => {
    const path = String(request.query?.path ?? '').trim();
    const enabled = isCascadeEnabled(ctx.store.getProjectCascadeEntries(), path);
    // Возвращаем и ключ: клиент показывает тумблер в чате, который может идти в
    // копии ветки, и человеку важно видеть, что правило относится к проекту.
    return { enabled, project: path ? cascadeProjectKey(resolve(path)) : '' };
  });

  app.put<{ Body: { path?: string; enabled?: boolean } }>('/api/chat/cascade', (request, reply) => {
    const path = String(request.body?.path ?? '').trim();
    if (!path)
      return reply
        .code(400)
        .send({ message: 'Нужен путь проекта', messageCode: 'project-path-required' });

    // Пишем по ключу ПРОЕКТА, а не по рабочей папке: выключено в копии ветки
    // значит выключено в проекте, иначе следующая копия правила не увидит.
    const project = cascadeProjectKey(resolve(path));
    ctx.store.setProjectCascade(project, request.body?.enabled !== false);
    return { enabled: request.body?.enabled !== false, project };
  });

  /**
   * Журнал понижённых прогонов веера. Свежие первыми — читают его сверху вниз,
   * а на диске он лежит в порядке записи. Сводка считается на сервере: правило
   * «что считать проверкой» одно и живёт рядом со списком образцов.
   */
  app.get('/api/chat/lowered-runs', () => {
    const records = readLoweredRuns(ctx.location.paths.appData);
    return { runs: [...records].reverse(), summary: summarizeLoweredRuns(records) };
  });
}
