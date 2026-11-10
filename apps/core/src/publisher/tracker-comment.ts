import type { JournalDataV1 } from '@agentdeck/contracts/core/journal';
import type { OutboxPort } from './push/push.types.ts';

/**
 * Комментарий назад в тикет (этап 12, D18, P166): задача из входящих трекера, открывшая MR, пишет
 * в свой тикет ровно одну строку — ссылку на MR. Выключено по умолчанию (`inbox.commentBack`).
 * Запись — только через outbox (`tracker-write`: `action.started` на диске ДО записи), и только
 * если у задачи ещё нет ни одного `tracker-write` этого тикета в любом состоянии: крах между
 * намерением и записью оставляет начатое действие, его исход решает сверка (читатель
 * `tracker-write` отвечает «неизвестно» → вопрос человеку), а не повтор вслепую. `trackerWrites:
 * ask` — сначала пункт 9 (W2-D): вопрос `tracker-write` уровня задачи, запись придержана; её
 * отпускает только «разрешить» человека из панели или с телефона (`approval`), ответ Telegram —
 * новый вопрос, отказ с любого канала — запись не будет никогда.
 */

/**
 * Ответ человека на последний вопрос пункта 9 о записи в этот тикет от этой единицы; `untrusted` —
 * «разрешить» пришёл каналом, который запись в трекер не отпускает (Telegram). Тот же тип у
 * `conductor/human/tracker-write-ask.ts` (части дирижёра публикатор не импортирует).
 */
export type TrackerWriteApproval =
  { state: 'none' | 'open' | 'approved' | 'declined' } | { state: 'untrusted'; channel: string };

export type MrRecord = JournalDataV1['publish.mr'];

/** Исход записи трекера: сделано / отказ по существу / «неизвестно» (решит сверка). */
export type TrackerPostResult =
  { value: true } | { refused: string; status: number } | { unknown: string };

/** Тикет задачи и чем в него писать; без значения доступа — его держит порт трекера. */
export interface TrackerCommentTarget {
  system: string;
  key: string;
  post(body: string): Promise<TrackerPostResult>;
}

export interface TrackerCommentPort {
  outbox: OutboxPort;
  /** Тикет задачи — или почему комментария нет (выключено, задача не из трекера, нет доступа). */
  target(): Promise<{ target: TrackerCommentTarget } | { skip: string }>;
  /** Есть ли у задачи `tracker-write` этого тикета — в ЛЮБОМ состоянии (начат, сделан, отказ). */
  wrote(key: string): boolean;
  /** Политика пункта 9 для записей в трекер (`humanPoints.trackerWrites`, пол — `ask`). */
  trackerWrites(): 'ask' | 'auto';
  /** Ответ на вопрос пункта 9 этого тикета и единицы (`trackerWrites: ask`). */
  approval(key: string, unitId: string): TrackerWriteApproval;
  /** Поднять блокирующий вопрос пункта 9 уровня задачи; открытый с тем же ключом — тот же. */
  askApproval(target: Pick<TrackerCommentTarget, 'system' | 'key'>, mr: MrRecord): void;
  note(message: string): void;
}

export type CommentBackOutcome =
  | { kind: 'written'; actionId: string }
  | { kind: 'skipped'; reason: string }
  | { kind: 'held'; reason: string }
  | { kind: 'failed'; code: string };

/** Текст комментария: ссылка на MR и больше ничего (никаких внутренних id). */
export function commentText(mr: Pick<MrRecord, 'url' | 'title'>): string {
  return mr.title
    ? `Merge request opened: ${mr.title}\n${mr.url}`
    : `Merge request opened: ${mr.url}`;
}

export async function commentBackOnce(
  port: TrackerCommentPort,
  mr: MrRecord,
): Promise<CommentBackOutcome> {
  const got = await port.target();
  if ('skip' in got) return { kind: 'skipped', reason: got.skip };
  const { target } = got;
  if (port.wrote(target.key))
    return { kind: 'skipped', reason: `ticket ${target.key} already has a tracker write` };
  if (port.trackerWrites() === 'ask') {
    const said = port.approval(target.key, mr.unitId);
    if (said.state === 'declined')
      return {
        kind: 'skipped',
        reason: `comment to ${target.key} declined by the human (point 9)`,
      };
    if (said.state !== 'approved') {
      if (said.state === 'untrusted')
        port.note(`comment to ${target.key}: approval via ${said.channel} does not release it`);
      if (said.state !== 'open') port.askApproval(target, mr);
      const reason = `comment to ${target.key} held: tracker writes ask first (point 9)`;
      port.note(reason);
      return { kind: 'held', reason };
    }
  }
  // Ни одного `await` от `wrote()` до `outbox.run`: `action.started` ложится раньше второго хода.
  const body = commentText(mr);
  const out = await port.outbox.run(
    {
      kind: 'tracker-write',
      target: target.key,
      idempotencyHint: `comment ${target.system} ${target.key} mr ${mr.mrIid}`,
    },
    async () => {
      const res = await target.post(body);
      if ('value' in res) return { ok: true, result: { key: target.key, mrIid: mr.mrIid } };
      if ('refused' in res) return { ok: false, code: 'tracker-refused', detail: res.refused };
      // Записал ли трекер — не узнать: повтора не будет никогда (`wrote` видит это действие).
      return { ok: false, code: 'tracker-unknown', detail: res.unknown };
    },
  );
  if (out.ok) return { kind: 'written', actionId: out.actionId };
  port.note(`comment to ${target.key} failed: ${out.code}`);
  return { kind: 'failed', code: out.code };
}

/** Вызов из `ensureMr`: MR только что опознан — комментарий назад; сбой комментария MR не роняет. */
export async function afterMrOpened<O extends { kind: string; record?: MrRecord }>(
  port: TrackerCommentPort | undefined,
  outcome: O,
): Promise<O> {
  if (!port || outcome.kind !== 'identified' || !outcome.record) return outcome;
  try {
    await commentBackOnce(port, outcome.record);
  } catch (error) {
    port.note(`comment back failed: ${(error as Error).message}`);
  }
  return outcome;
}
