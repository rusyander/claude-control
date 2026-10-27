import { resolve } from 'node:path';
import type { FastifyInstance } from 'fastify';
import type { ServerContext } from '../../context.ts';
import type { CascadeRulePatch, CascadeRuleView } from '@agentdeck/contracts/model-cascade';
import {
  cascadeProjectKey,
  isCascadeEnabled,
  isReviewAfterWork,
} from '../../domains/model-cascade/model-cascade.ts';
import {
  readLoweredRuns,
  summarizeLoweredRuns,
} from '../../domains/chat/lowered-journal/lowered-journal.ts';
import { readRunInputs } from '../../domains/chat/run-input/run-input.ts';
import type { RunInputsResponse } from '@agentdeck/contracts/run-input';

/**
 * Правило «Подбирать модель под задачу» — чтение и запись положения тумблера.
 *
 * Тумблер стоит в меню чата рядом с правами, а помнится на проект: см.
 * `domains/model-cascade/model-cascade.ts`. Отдельный маршрут, а не поле настроек, именно
 * поэтому — у настроек панели нет проектной области, а заводить её ради одного
 * тумблера значило бы переписать схему, которую читают ещё телефон и импорт
 * снимка.
 */
export function registerChatCascadeRoutes(app: FastifyInstance, ctx: ServerContext): void {
  // Оба тумблера правила одной области — проекта (R3(d), 26.10: «Ревью после
  // работы» рядом с подбором): один маршрут, один ответ.
  const viewOf = (path: string): CascadeRuleView => ({
    enabled: isCascadeEnabled(ctx.store.getProjectCascadeEntries(), path),
    reviewAfterWork: isReviewAfterWork(ctx.store.getProjectReviewEntries(), path),
    // Возвращаем и ключ: клиент показывает тумблер в чате, который может идти в
    // копии ветки, и человеку важно видеть, что правило относится к проекту.
    project: path ? cascadeProjectKey(resolve(path)) : '',
  });

  app.get<{ Querystring: { path?: string } }>('/api/chat/cascade', (request) =>
    viewOf(String(request.query?.path ?? '').trim()),
  );

  app.put<{ Body: Partial<CascadeRulePatch> }>('/api/chat/cascade', (request, reply) => {
    const body = request.body ?? {};
    const path = String(body.path ?? '').trim();
    if (!path)
      return reply
        .code(400)
        .send({ message: 'Нужен путь проекта', messageCode: 'project-path-required' });

    // Пишем по ключу ПРОЕКТА, а не по рабочей папке: выключено в копии ветки
    // значит выключено в проекте, иначе следующая копия правила не увидит.
    const project = cascadeProjectKey(resolve(path));
    const review = typeof body.reviewAfterWork === 'boolean' ? body.reviewAfterWork : undefined;
    if (review !== undefined) ctx.store.setProjectReviewAfterWork(project, review);
    // Подбор меняется, когда назван, — или когда тело старого вида (`{ path }` без
    // обоих полей значило «включить»): запись одного ревью подбор не трогает.
    if (typeof body.enabled === 'boolean' || review === undefined)
      ctx.store.setProjectCascade(project, body.enabled !== false);
    return viewOf(project);
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

  /**
   * «Что получил агент» (U8): дословные входы последних прогонов разговора,
   * свежие первыми. Ключ — как у связи конвейера: `sessionId` у Claude,
   * `<провайдер>:<id>` у чужого CLI. Разговор без записей — пустой список:
   * он старше записи или панель его не запускала.
   */
  app.get<{ Params: { chatId: string } }>(
    '/api/chat/:chatId/received',
    (request): RunInputsResponse => ({
      runs: readRunInputs(ctx.location.paths.appData, request.params.chatId),
    }),
  );
}
