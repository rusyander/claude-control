import type { FastifyInstance } from 'fastify';
import type { ServerContext } from '../../context.ts';
import {
  readLoweredRuns,
  summarizeLoweredRuns,
} from '../../domains/chat/lowered-journal/lowered-journal.ts';
import { readRunInputs } from '../../domains/chat/run-input/run-input.ts';
import type { RunInputsResponse } from '@agentdeck/contracts/run-input';

/**
 * Журналы прогонов чата: понижённые прогоны веера и дословные входы агента.
 *
 * Правило проекта «Подбирать модель под задачу» (`GET/PUT /api/chat/cascade`)
 * снято вместе с тумблером в меню чата (этап 10, G14): подбор по роду работы шёл
 * только в предложение разделения, а разделение из чата снято.
 */
export function registerChatCascadeRoutes(app: FastifyInstance, ctx: ServerContext): void {
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
