import type { JournalLine } from '@agentdeck/contracts/core/journal';
import type { Predicate, SignalVerdict } from '../observer.types.ts';
import { contextOf, toolEventOf, whereOf, type ToolEventData } from './facts.ts';

/**
 * Перечитывание (06:134, F3): тот же файл с тем же отпечатком читается снова в том же контексте,
 * и прежнее чтение уже покрыло новое окно (чтение целиком покрывает любое; соседнее или частично
 * перекрытое окно — нет; урезанное самим CLI чтение без окна — только такое же). Ключ — сессия × контекст × путь × отпечаток: правка меняет отпечаток, и
 * чтение после неё — новое. Сработка — один раз на (путь, отпечаток): подсказка со второго чтения.
 * Сжатие контекста (доля контекста главной сессии упала больше чем вдвое между ходами, видно по
 * `turn.usage`) — свёртка главного контекста сессии начинается заново: прочитанное забыто моделью.
 */

export const WASTE_REREAD = 'waste-reread';

type Range = ToolEventData['range'];

interface ReadMark {
  fp: string;
  ranges: Range[];
}

export interface RereadState {
  /** Контекст → путь → прочитанные окна при отпечатке. */
  reads: ReadonlyMap<string, ReadonlyMap<string, ReadMark>>;
  /** Последний контекст главной сессии в токенах (для распознавания сжатия). */
  usage: ReadonlyMap<string, number>;
}

/** Доля, ниже которой падение контекста — сжатие (F3: «больше чем вдвое»). */
const COMPACTION_SHARE = 0.5;

/** Окно самого CLI (оба поля `null`, `CLI_DEFAULT_WINDOW`): Qwen без окна режет файл по размеру. */
const cliWindow = (r: Range): boolean => r !== null && r.offset === null && r.limit === null;

/**
 * Окно `prev` покрывает окно `next`: целиком — любое; хвост — только тот же хвост; окно CLI —
 * только такое же окно CLI (что именно оно вместило, CLI не сообщает).
 */
export function covers(prev: Range, next: Range): boolean {
  if (cliWindow(prev) || cliWindow(next)) return cliWindow(prev) && cliWindow(next);
  if (prev === null) return true;
  if (next === null) return false;
  const tail = (prev.offset ?? 1) < 0 || (next.offset ?? 1) < 0;
  if (tail) return prev.offset === next.offset && prev.limit === next.limit;
  const start = (r: NonNullable<Range>): number => r.offset ?? 1;
  const end = (r: NonNullable<Range>): number =>
    r.limit === null ? Number.POSITIVE_INFINITY : start(r) + r.limit;
  return start(prev) <= start(next) && end(prev) >= end(next);
}

function onUsage(state: RereadState, line: JournalLine): RereadState {
  const d = (line as JournalLine<'turn.usage'>).data;
  if (d.subagent || d.remainder) return state;
  const tokens = d.input + d.cacheRead + d.cacheWrite;
  const usage = new Map(state.usage).set(d.sessionId, tokens);
  const prev = state.usage.get(d.sessionId);
  if (prev === undefined || tokens >= prev * COMPACTION_SHARE) return { ...state, usage };
  const reads = new Map(state.reads);
  reads.delete(contextOf({ sessionId: d.sessionId, parentToolUseId: null }));
  return { reads, usage };
}

export const rereadPredicate: Predicate<RereadState> = {
  ids: [WASTE_REREAD],
  init: () => ({ reads: new Map(), usage: new Map() }),
  step(state, line) {
    if (line.kind === 'turn.usage') return { state: onUsage(state, line), verdicts: [] };
    const ev = toolEventOf(line);
    if (!ev) return { state, verdicts: [] };
    const d = ev.data;
    if (d.effectClass !== 'read' || d.isError || d.fileFp === null || d.target === '')
      return { state, verdicts: [] };
    const ctx = contextOf(d);
    const files = state.reads.get(ctx) ?? new Map<string, ReadMark>();
    const prior = files.get(d.target);
    const same = prior !== undefined && prior.fp === d.fileFp;
    const verdicts: SignalVerdict[] = [];
    if (same && prior.ranges.some((r) => covers(r, d.range))) {
      verdicts.push({
        fired: true,
        signal: WASTE_REREAD,
        subject: d.target,
        detail: `read again with the same fingerprint (${d.fileFp.slice(0, 19)}) in ${ctx.endsWith('|main') ? 'the main context' : 'a subagent context'}`,
        reasons: [
          `an earlier read of ${d.target} in this context covers the new window`,
          'the file fingerprint did not change since that read',
        ],
        key: `${WASTE_REREAD}:${ctx}:${d.target}:${d.fileFp}`,
        ...whereOf(line),
        inputs: [line.seq],
      });
    }
    const mark: ReadMark = same
      ? { fp: prior.fp, ranges: [...prior.ranges, d.range] }
      : { fp: d.fileFp, ranges: [d.range] };
    const reads = new Map(state.reads).set(ctx, new Map(files).set(d.target, mark));
    return { state: { ...state, reads }, verdicts };
  },
};
