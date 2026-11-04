import {
  TASK_ATTACHMENT_BODY_LIMIT,
  taskAttachmentBodySchema,
  type TaskAttachmentReply,
} from '@agentdeck/contracts/core/estimate';
import { isUuidv7 } from '@agentdeck/contracts/core/ids';
import { storeAttachment, taskAttachmentsDir } from '../conductor/attachments/attachments.ts';
import { decideAuthority } from '../policy/authority/authority.ts';
import { proofOfBody } from './body-proof.ts';
import { apiError, commandStatus } from './errors.ts';
import type { RouteContext } from './route-context.types.ts';
import type { FastifyInstance } from 'fastify';

/**
 * `POST /v1/tasks/:id/attachments` (этап 10, s10 G11): вложение следующего хода чата — копия ядра в
 * каталоге вложений задачи (`taskAttachmentsDir`, вне дома ядра), который судья чтения открывает её
 * сеансам. Полномочия — класс `message-to-step`:
 * вложение служит слову человека и без него смысла не имеет. Журнал не пишется: байты в журнал не
 * ложатся, а путь копии попадёт туда текстом самого `message-to-step`.
 */
export function registerTaskAttachments(app: FastifyInstance, ctx: RouteContext): void {
  app.post<{ Params: { id: string } }>(
    '/v1/tasks/:id/attachments',
    { bodyLimit: TASK_ATTACHMENT_BODY_LIMIT },
    async (request, reply) => {
      const token = ctx.tokenOf(request);
      if (token === 'none') {
        return reply.code(401).send(apiError('token-required', 'Нужен токен ядра'));
      }
      const taskId = request.params.id;
      if (!isUuidv7(taskId)) return reply.code(404).send(apiError('no-task', 'Задачи нет'));
      const parsed = taskAttachmentBodySchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send(
          apiError('bad-attachment', 'Вложение не прошло разбор', {
            issues: parsed.error.issues.map((i) => ({
              path: i.path.join('.'),
              message: i.message,
            })),
          }),
        );
      }
      const authority = decideAuthority(
        'message-to-step',
        await proofOfBody(
          request.raw,
          'POST /v1/tasks/:id/attachments',
          parsed.data,
          token,
          ctx.proof,
        ),
      );
      if (!authority.allow) {
        return reply
          .code(commandStatus(authority.code))
          .send(apiError(authority.code, authority.reason));
      }
      let view: ReturnType<RouteContext['registry']['view']>;
      try {
        view = ctx.registry.view(taskId);
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        return reply.code(500).send(apiError('journal-unreadable', reason));
      }
      if (!view) return reply.code(404).send(apiError('no-task', 'Задачи нет'));
      if (view.ended !== null) {
        return reply.code(409).send(apiError('task-ended', `task ended: ${view.ended}`));
      }
      const stored = storeAttachment(
        taskAttachmentsDir(ctx.registry.tasksDir, taskId),
        parsed.data.cmdId,
        parsed.data.attachment,
      );
      if (!stored.ok) {
        return reply
          .code(422)
          .send(
            apiError('attachment-refused', 'Вложение не принято', { problems: [stored.problem] }),
          );
      }
      const body: TaskAttachmentReply = stored.stored;
      return reply.code(201).send(body);
    },
  );
}
