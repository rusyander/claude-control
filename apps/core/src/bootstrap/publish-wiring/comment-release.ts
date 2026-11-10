import {
  latestTrackerWriteAsks,
  parseTrackerWriteDedupe,
} from '../../conductor/next/tracker-write.ts';
import { publicationOf } from '../../journal/reduce/publish.ts';
import type { LiveTask } from '../../journal/resume.ts';
import type { OutboxPort } from '../../publisher/push/push.types.ts';
import { commentBackOnce, type TrackerCommentPort } from '../../publisher/tracker-comment.ts';
import { outboxPort } from './outbox-port.ts';

/**
 * Отпускание придержанного комментария назад в тикет (этап 12, P166, W2-D). Ответ на вопрос
 * пункта 9 (`human.answered` вопроса `tracker-write`) — и разок при подключении задачи (ответ мог
 * лечь до перезапуска ядра) — снова зовёт `commentBackOnce` для MR единицы из ключа вопроса: суд
 * ответа (канал, вариант) — там же, в порту. «Разрешить» из Telegram — новый вопрос.
 *
 * Запуски одной задачи — по очереди: два ответа подряд не дадут двух записей (`wrote` видит
 * `action.started` первой). «Разрешить» без записи (настройку выключили, Jira панели нет) всё же
 * оставляет действие `tracker-write` с отказом `comment-skipped`: иначе конец задачи ждал бы
 * записи вечно (`conductor/next/tracker-write.ts`).
 */

export interface CommentReleaseDeps {
  commentBack(task: LiveTask, outbox: OutboxPort): TrackerCommentPort;
  note(event: string, data: Record<string, unknown>): void;
}

async function releaseOnce(task: LiveTask, deps: CommentReleaseDeps): Promise<void> {
  for (const [dedupe, ask] of latestTrackerWriteAsks(task.state.asks)) {
    if (task.state.ended !== null) return;
    if (ask.state !== 'answered') continue;
    const parsed = parseTrackerWriteDedupe(dedupe);
    const mr = parsed ? publicationOf(task.state, parsed.unitId).mr : null;
    if (!parsed || !mr) continue;
    const port = deps.commentBack(task, outboxPort(task, { unitId: parsed.unitId }));
    if (port.wrote(parsed.key)) continue;
    const out = await commentBackOnce(port, mr);
    deps.note('inbox.comment-release', { taskId: task.taskId, key: parsed.key, outcome: out.kind });
    if (out.kind !== 'skipped' || port.wrote(parsed.key)) continue;
    if (port.approval(parsed.key, parsed.unitId).state !== 'approved') continue;
    // Разрешено, но писать некуда: действие с отказом — исход записи назван, конец не ждёт.
    await port.outbox.run(
      {
        kind: 'tracker-write',
        target: parsed.key,
        idempotencyHint: `comment skipped ${parsed.key} mr ${mr.mrIid}`,
      },
      async () => ({ ok: false, code: 'comment-skipped', detail: out.reason }),
    );
    port.note(`comment to ${parsed.key} approved but not written: ${out.reason}`);
  }
}

export function createCommentRelease(deps: CommentReleaseDeps): { attach(task: LiveTask): void } {
  return {
    attach(task) {
      let chain = Promise.resolve();
      const run = (): void => {
        chain = chain
          .then(() => releaseOnce(task, deps))
          .catch((error: unknown) =>
            deps.note('inbox.comment-release', {
              taskId: task.taskId,
              message: error instanceof Error ? error.message : String(error),
            }),
          );
      };
      task.subscribe((line) => {
        if (line.kind !== 'human.answered') return;
        const askId = (line.data as { askId?: string }).askId ?? '';
        if (task.state.asks[askId]?.source === 'tracker-write') run();
      });
      run();
    },
  };
}
