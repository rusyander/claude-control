import type { JournalDataV1, JournalLine } from '@agentdeck/contracts/core/journal';
import { currentOs, type OsKind } from '../../platform/os-kind.ts';

/**
 * Общие факты предикатов расточительства (этап 8, 06:134-137): строки журнала, по которым они
 * судят, и ключ контекста. Подагент — свой контекст (R11): его чтение файла, прочитанного главным
 * контекстом, — не перечитывание. Вызов без известного родителя судится как главный (`main`).
 */

export type ToolEventData = JournalDataV1['tool.event'];

export interface ToolEventLine {
  line: JournalLine<'tool.event'>;
  data: ToolEventData;
}

/**
 * Строка вызова. Строка отказа CLI (`denied`) — не вызов: у того же id есть своя строка вызова,
 * и счёт перечитываний, падений и опросов её не видит; её читает только `cliRefusalOf`.
 */
export function toolEventOf(line: JournalLine): ToolEventLine | null {
  if (line.kind !== 'tool.event') return null;
  const typed = line as JournalLine<'tool.event'>;
  if (typed.data.denied) return null;
  return { line: typed, data: typed.data };
}

/** Ключ контекста вызова: сессия × родитель-подагент (`main` — главный контекст). */
export const contextOf = (d: Pick<ToolEventData, 'sessionId' | 'parentToolUseId'>): string =>
  `${d.sessionId}|${d.parentToolUseId ?? 'main'}`;

/** Где вердикт: шаг и сессия строки-факта. */
export function whereOf(line: JournalLine): { stepId?: string; sessionId?: string } {
  return {
    ...(line.stepId ? { stepId: line.stepId } : {}),
    ...(line.sessionId ? { sessionId: line.sessionId } : {}),
  };
}

/** Отказ допуска, как его пишет судья права (`decision{class:'permit'}`, обе дороги). */
export interface PermitRefusal {
  stepId: string;
  sessionId: string | null;
  action: string;
  target: string;
  code: string;
  humanPoint: number | null;
  /** id вызова у CLI; `null` — дорога его не назвала. */
  toolUseId: string | null;
  /** Инструмент CLI вызова (`Bash`, `Read`); пусто — дорога его не назвала. */
  tool: string;
  at: number;
}

export function permitRefusalOf(line: JournalLine): PermitRefusal | null {
  if (line.kind !== 'decision' || !line.stepId) return null;
  const d = (line as JournalLine<'decision'>).data;
  if (d.class !== 'permit') return null;
  const out = d.output as Record<string, unknown> | null;
  if (!out || out.allow !== false) return null;
  const str = (v: unknown): string => (typeof v === 'string' ? v : '');
  return {
    stepId: line.stepId,
    sessionId: line.sessionId ?? null,
    action: str(out.action),
    target: str(out.target),
    code: str(out.code),
    humanPoint: typeof out.humanPoint === 'number' ? out.humanPoint : null,
    toolUseId: typeof out.toolUseId === 'string' && out.toolUseId !== '' ? out.toolUseId : null,
    tool: str(out.tool),
    at: line.at,
  };
}

/** Код отказа самого CLI: судья ядра вызова не видел. */
export const CLI_DENIED = 'cli-denied';

/**
 * Отказ самого CLI (`tool.event` с `denied`, W P-c) — как отказ допуска: действие — класс
 * вызова, код `cli-denied`, id вызова CLI всегда есть (без него строки нет).
 */
export function cliRefusalOf(line: JournalLine): PermitRefusal | null {
  if (line.kind !== 'tool.event' || !line.stepId) return null;
  const d = (line as JournalLine<'tool.event'>).data;
  if (!d.denied) return null;
  return {
    stepId: line.stepId,
    sessionId: d.sessionId,
    action: d.effectClass,
    target: d.target,
    code: CLI_DENIED,
    humanPoint: null,
    toolUseId: d.toolUseId,
    tool: d.tool,
    at: line.at,
  };
}

/** Цель для сравнения: на Windows регистр и разделители не различают один и тот же путь. */
export function targetKey(target: string, os: OsKind = currentOs()): string {
  return os === 'win32' ? target.replaceAll('/', '\\').toLowerCase() : target;
}
