import type {
  BoardEntry,
  BoardRelated,
  BoardSource,
  BoardStop,
} from '@agentdeck/contracts/core/board';
import { rankIn } from '../board/moves.ts';
import type { BoardFile } from '../board/store.types.ts';
import type { IntakeDraft } from './kind.ts';

/**
 * Одна запись доски на ключ тикета — навсегда (этап 12, P163). Ключ — вид источника доски и ключ
 * тикета; ищется по ВСЕМ записям, в любом состоянии: отклонённая или уже ставшая задачей запись не
 * пересоздаётся. Имя источника входящих (`system`) в ключ трекера и форжа НЕ входит: Jira и GitLab у
 * панели по одному, и два источника (или переименованный) читают тот же тикет — без этого он стал
 * бы второй записью и второй задачей, а отклонённый вернулся бы. Изменённый отпечаток помечает
 * запись причиной: во «Входящих» снимок обновляется (её ещё никто не ставил в очередь), в
 * очереди — только пометка (человек ставил в очередь тот снимок), начатой и отклонённой — ничего.
 *
 * Правка идёт по копии файла внутри одного писателя доски (`BoardPort.intake`): решение и запись —
 * один шаг, второй опрос между ними не вклинится.
 */

/** Ключ дедупликации записи; у записи без ключа тикета (рукой, из чата) — нет. */
export function dedupeKey(source: Pick<BoardSource, 'kind' | 'system' | 'key'>): string | null {
  if (!source.key) return null;
  const perPanel = source.kind === 'tracker' || source.kind === 'forge';
  return `${source.kind}\u0000${perPanel ? '' : (source.system ?? '')}\u0000${source.key}`;
}

/** Пометка «тикет изменён»: английской прозой ядра, как все причины доски. */
export const CHANGED_IN_INBOX = 'ticket changed at the source: snapshot refreshed';
export const CHANGED_IN_QUEUE =
  'ticket changed at the source after it was queued: the queued snapshot is kept';

export interface IntakeContext {
  at: number;
  /** Остановка по умолчанию — раздел `board`. */
  stop: BoardStop;
  newId(): string;
  /**
   * Автоочередь источника включена записью настройки `cmdId` (D28, P183): новые записи — в
   * очередь с доказательством `config`; нет — во «Входящие».
   */
  queueBy?: { cmdId: string } | null;
}

export interface IntakeResult {
  created: string[];
  /** Ключ уже был: id существующей записи (по порядку черновиков). */
  existing: string[];
  /** Записи, которым отпечаток сменился (пометка поставлена). */
  marked: string[];
}

type Draft = Pick<IntakeDraft, 'preset' | 'source' | 'launch' | 'reason'> & {
  digest?: string;
  /** Факты связей тикета (D26): запись хранит их для подсказки «связано с …». */
  related?: BoardRelated;
};

function mark(entry: BoardEntry, draft: Draft): boolean {
  if (draft.digest === undefined || entry.digest === undefined || entry.digest === draft.digest)
    return false;
  if (entry.state === 'inbox') {
    entry.source = draft.source;
    entry.launch = draft.launch;
    entry.preset = draft.preset;
    entry.digest = draft.digest;
    if (draft.related) entry.related = draft.related;
    entry.reason = draft.reason ? `${CHANGED_IN_INBOX}; ${draft.reason}` : CHANGED_IN_INBOX;
    return true;
  }
  if (entry.state === 'queued') {
    if (entry.reason === CHANGED_IN_QUEUE) return false;
    entry.reason = CHANGED_IN_QUEUE;
    return true;
  }
  return false;
}

/** Положить черновики в копию файла доски: новые — записи, бывшие — пометка при сдвиге. */
export function applyIntake(
  file: BoardFile,
  drafts: readonly Draft[],
  ctx: IntakeContext,
): IntakeResult {
  const out: IntakeResult = { created: [], existing: [], marked: [] };
  const byKey = new Map<string, BoardEntry>();
  for (const entry of file.entries) {
    // Источники, сложенные в запись ходом `merge` (P186), держат свои ключи: тикет, слитый в
    // другую запись, опрос не заводит заново.
    for (const source of [entry.source, ...(entry.merged ?? [])]) {
      const key = dedupeKey(source);
      if (key !== null && !byKey.has(key)) byKey.set(key, entry);
    }
  }
  for (const draft of drafts) {
    const key = dedupeKey(draft.source);
    const known = key === null ? undefined : byKey.get(key);
    if (known) {
      out.existing.push(known.entryId);
      // Тикет, сложенный в запись (`merged`), — не её собственный: его отпечаток с отпечатком записи
      // не сравнивается, иначе каждый опрос переписывал бы снимок выжившей записи чужим тикетом.
      if (key !== dedupeKey(known.source)) continue;
      if (mark(known, draft)) out.marked.push(known.entryId);
      continue;
    }
    const queued = Boolean(ctx.queueBy);
    const state = queued ? 'queued' : 'inbox';
    const entryId = ctx.newId();
    const rank = rankIn(file.entries, state, entryId, { tail: true }) as number;
    const entry: BoardEntry = {
      entryId,
      state,
      rank,
      stop: ctx.stop,
      preset: draft.preset,
      source: draft.source,
      launch: draft.launch,
      ...(queued && ctx.queueBy
        ? { proof: { kind: 'config' as const, cmdId: ctx.queueBy.cmdId } }
        : {}),
      ...(draft.digest ? { digest: draft.digest } : {}),
      ...(draft.related ? { related: draft.related } : {}),
      createdAt: ctx.at,
      ...(draft.reason ? { reason: draft.reason.slice(0, 2000) } : {}),
    };
    file.entries.push(entry);
    if (key !== null) byKey.set(key, entry);
    out.created.push(entryId);
  }
  return out;
}

/** Черновик из тикета → форма для `applyIntake` (отпечаток тикета — отпечаток записи). */
export function withDigest(draft: IntakeDraft): Draft {
  return {
    preset: draft.preset,
    source: draft.source,
    launch: draft.launch,
    digest: draft.item.digest,
    related: draft.item.related,
    ...(draft.reason ? { reason: draft.reason } : {}),
  };
}
