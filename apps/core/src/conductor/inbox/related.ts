import type {
  BoardCard,
  BoardEntry,
  BoardRelated,
  BoardRelatedHint,
  BoardRelatedReason,
  BoardReply,
} from '@agentdeck/contracts/core/board';

/**
 * Подсказки «связано с …» (этап 12, D26, P186) — чистая функция фактов тикета: общий эпик или
 * родитель (или одна запись — родитель другой), связь задач трекера или форжа, путь, названный в
 * обоих тикетах. Метки, система, заголовок и автор связью НЕ считаются: общая метка источника есть
 * у всех записей опроса, и подсказка на каждой карточке не значила бы ничего. Подсказка — только
 * подсказка: объединяет записи ход человека `merge` (`board/moves.ts`), ядро не сливает никогда.
 */

/** Что запись знает о своих тикетах: ключи (свой и сложенных в неё) и факты связей. */
interface Side {
  keys: ReadonlySet<string>;
  related: BoardRelated | undefined;
}

/** Путь из текста тикета в сравнимом виде: косые черты одной формы, без ведущего `./`. */
export function normalPath(path: string): string {
  return path
    .trim()
    .replace(/\\/g, '/')
    .replace(/^(\.\/)+/, '');
}

function sideOf(entry: Pick<BoardEntry, 'source' | 'merged' | 'related'>): Side {
  const keys = new Set<string>();
  for (const s of [entry.source, ...(entry.merged ?? [])]) if (s.key) keys.add(s.key);
  return { keys, related: entry.related };
}

/** Эпик: общий родитель у обеих, или родитель одной — тикет другой. */
function sharesEpic(a: Side, b: Side): boolean {
  const ea = a.related?.epic;
  const eb = b.related?.epic;
  if (ea !== undefined && eb !== undefined && ea === eb) return true;
  return (ea !== undefined && b.keys.has(ea)) || (eb !== undefined && a.keys.has(eb));
}

/** Связь: тикет одной назван связью другой (в любую сторону — трекер отдаёт связь с обеих). */
function linked(a: Side, b: Side): boolean {
  const la = a.related?.links ?? [];
  const lb = b.related?.links ?? [];
  return la.some((k) => b.keys.has(k)) || lb.some((k) => a.keys.has(k));
}

function sharesPath(a: Side, b: Side): boolean {
  const pa = new Set((a.related?.paths ?? []).map(normalPath).filter((p) => p !== ''));
  return (b.related?.paths ?? []).some((p) => pa.has(normalPath(p)));
}

/** Почему две записи связаны; пусто — не связаны. Порядок причин — порядок контракта. */
export function relatedReasons(
  a: Pick<BoardEntry, 'source' | 'merged' | 'related'>,
  b: Pick<BoardEntry, 'source' | 'merged' | 'related'>,
): BoardRelatedReason[] {
  const sa = sideOf(a);
  const sb = sideOf(b);
  const out: BoardRelatedReason[] = [];
  if (sharesEpic(sa, sb)) out.push('epic');
  if (linked(sa, sb)) out.push('link');
  if (sharesPath(sa, sb)) out.push('path');
  return out;
}

/**
 * Подсказки для каждой записи «Входящих»: с какими ДРУГИМИ записями «Входящих» она связана. Только
 * входящие — объединить можно только их (`merge` из очереди — 409); порядок — порядок колонки.
 */
export function relatedHintsOf(entries: readonly BoardEntry[]): Map<string, BoardRelatedHint[]> {
  const inbox = entries.filter((e) => e.state === 'inbox').sort((x, y) => x.rank - y.rank);
  const out = new Map<string, BoardRelatedHint[]>();
  for (const a of inbox) {
    const hints: BoardRelatedHint[] = [];
    for (const b of inbox) {
      if (b.entryId === a.entryId) continue;
      const reasons = relatedReasons(a, b);
      if (reasons.length > 0) hints.push({ entryId: b.entryId, title: b.source.title, reasons });
    }
    if (hints.length > 0) out.set(a.entryId, hints);
  }
  return out;
}

/** Снимок доски с подсказками на карточках записей «Входящих»; без связей — карточка как была. */
export function withRelatedHints<R extends Pick<BoardReply, 'cards' | 'entries'>>(reply: R): R {
  const hints = relatedHintsOf(reply.entries);
  if (hints.size === 0) return reply;
  const cards: BoardCard[] = reply.cards.map((card) => {
    const own = card.kind === 'entry' && card.entryId ? hints.get(card.entryId) : undefined;
    return own ? { ...card, related: own } : card;
  });
  return { ...reply, cards };
}

const LINKS_MAX = 100;
const PATHS_MAX = 200;

/**
 * Факты связей записи после `merge`: эпик — свой, иначе первый из сложенных; связи и пути —
 * объединение без повторов в пределах схемы. Связь на тикет, ставший частью этой же записи, уже
 * ничего не подсказывает и выпадает.
 */
export function mergedRelated(
  target: Pick<BoardEntry, 'source' | 'merged' | 'related'>,
  folded: readonly Pick<BoardEntry, 'source' | 'merged' | 'related'>[],
): BoardRelated | undefined {
  const all = [target, ...folded];
  const own = new Set<string>();
  for (const e of all) for (const k of sideOf(e).keys) own.add(k);
  const epic = all.map((e) => e.related?.epic).find((v) => v !== undefined && !own.has(v));
  const links = [...new Set(all.flatMap((e) => e.related?.links ?? []))].filter((k) => !own.has(k));
  const paths = [...new Set(all.flatMap((e) => e.related?.paths ?? []))];
  if (epic === undefined && links.length === 0 && paths.length === 0 && !target.related)
    return undefined;
  return {
    ...(epic !== undefined ? { epic } : {}),
    links: links.slice(0, LINKS_MAX),
    paths: paths.slice(0, PATHS_MAX),
  };
}
