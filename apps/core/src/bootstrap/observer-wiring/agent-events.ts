import { uuidv7 } from '@agentdeck/contracts/core/ids';
import type { JournalLine } from '@agentdeck/contracts/core/journal';
import type { AdapterEvent } from '../../adapters/adapter.types.ts';
import type { SessionBinding } from '../../conductor/model-tools/model-tools.types.ts';
import type { LiveTask } from '../../journal/resume.ts';

/**
 * Строки истории агентов (этап 11, P146-P148) из событий переходника: `agent.spawned` /
 * `agent.ended` (субагенты) и `bg.started` / `bg.ended` (фон с полной цепочкой владельца). Сырые
 * тексты (вводная, итог, команда) здесь маскируются и ТОЛЬКО потом режутся: срез до маски мог бы
 * разрезать секрет так, что маска его уже не узнает. Строка, уже лежащая в журнале (ядро упало
 * между строкой и концом истории), второй раз не пишется — ключи пересобираются из журнала.
 */

export type AgentEvent = Extract<
  AdapterEvent,
  { type: 'agent.spawned' | 'agent.ended' | 'bg.started' | 'bg.ended' }
>;

const AGENT_TYPES = new Set<string>(['agent.spawned', 'agent.ended', 'bg.started', 'bg.ended']);

export const isAgentEvent = (event: AdapterEvent): event is AgentEvent =>
  AGENT_TYPES.has(event.type);

/** Пределы схемы журнала (`journal-data.ts`): выдержки и имена. */
const BRIEF_MAX = 2_000;
const BG_EXCERPT_MAX = 500;
const OUTPUT_FILE_MAX = 1_000;
const NAME_MAX = 200;
const ID_MAX = 256;
export const TARGET_MAX = 2_000;

/** Маска, потом срез; пусто — `null`. */
export function excerptOf(mask: LiveTask['mask'], text: string | null, max: number): string | null {
  if (text === null) return null;
  const cut = mask(text).text.slice(0, max);
  return cut === '' ? null : cut;
}

const name = (text: string | null): string | null =>
  text === null || text === '' ? null : text.slice(0, NAME_MAX);
const id = (text: string): string => text.slice(0, ID_MAX);

/** Ключ записанной строки: сессия + вызов для агента, сессия + работа для фона. */
function keyOf(kind: string, sessionId: string, subject: string): string {
  return `${kind}\u0000${sessionId}\u0000${subject}`;
}

/** Ключ строки журнала, если это строка истории агентов (`tool.started` — тоже); иначе `null`. */
export function journaledKey(line: JournalLine): string | null {
  const sessionId = line.sessionId;
  if (!sessionId) return null;
  const data = line.data as { toolUseId?: string; itemId?: string };
  if (line.kind === 'tool.started' || line.kind === 'agent.spawned' || line.kind === 'agent.ended')
    return data.toolUseId ? keyOf(line.kind, sessionId, data.toolUseId) : null;
  if (line.kind === 'bg.started' || line.kind === 'bg.ended')
    return data.itemId ? keyOf(line.kind, sessionId, data.itemId) : null;
  return null;
}

export const startedKey = (sessionId: string, toolUseId: string): string =>
  keyOf('tool.started', sessionId, id(toolUseId));

type Row =
  | { kind: 'agent.spawned'; key: string; data: JournalLine<'agent.spawned'>['data'] }
  | { kind: 'agent.ended'; key: string; data: JournalLine<'agent.ended'>['data'] }
  | { kind: 'bg.started'; key: string; data: JournalLine<'bg.started'>['data'] }
  | { kind: 'bg.ended'; key: string; data: JournalLine<'bg.ended'>['data'] };

function rowOf(task: LiveTask, binding: SessionBinding, event: AgentEvent, wall: number): Row {
  const sessionId = binding.sessionId;
  const mask = task.mask;
  switch (event.type) {
    case 'agent.spawned':
      return {
        kind: event.type,
        key: keyOf(event.type, sessionId, id(event.toolUseId)),
        data: {
          sessionId,
          toolUseId: id(event.toolUseId),
          parentToolUseId: event.parentToolUseId === null ? null : id(event.parentToolUseId),
          cliTaskId: id(event.cliTaskId),
          kind: event.kind,
          subagentType: name(event.subagentType),
          model: name(event.model),
          effort: name(event.effort),
          background: event.background,
          depth: event.depth,
          briefExcerpt: excerptOf(mask, event.brief, BRIEF_MAX),
        },
      };
    case 'agent.ended':
      return {
        kind: event.type,
        key: keyOf(event.type, sessionId, id(event.toolUseId)),
        data: {
          sessionId,
          toolUseId: id(event.toolUseId),
          cliTaskId: id(event.cliTaskId),
          how: event.how,
          usage: event.usage,
          summaryExcerpt: excerptOf(mask, event.summary, BRIEF_MAX),
        },
      };
    case 'bg.started': {
      const file = excerptOf(mask, event.outputFile ?? null, Number.POSITIVE_INFINITY);
      return {
        kind: event.type,
        key: keyOf(event.type, sessionId, id(event.itemId)),
        data: {
          itemId: id(event.itemId),
          kind: event.kind,
          excerpt: excerptOf(mask, event.excerpt, BG_EXCERPT_MAX) ?? '',
          ownerChain: {
            taskId: binding.taskId,
            stepId: binding.stepId,
            // Шаг без единицы (сеанс ведущего) — `null`, а не чужой id.
            unitId: uuidv7.safeParse(binding.unitId).success ? binding.unitId : null,
            sessionId,
            toolUseId: id(event.toolUseId),
            parentToolUseId: event.parentToolUseId === null ? null : id(event.parentToolUseId),
          },
          ...(event.pid !== undefined ? { pid: event.pid } : {}),
          // Обрезанный путь указал бы на чужой файл: длиннее предела — файла нет.
          ...(file !== null && file.length <= OUTPUT_FILE_MAX ? { outputFile: file } : {}),
          startedAt: event.startedAt ?? wall,
        },
      };
    }
    case 'bg.ended': {
      const summary = excerptOf(mask, event.summary ?? null, BRIEF_MAX);
      return {
        kind: event.type,
        key: keyOf(event.type, sessionId, id(event.itemId)),
        data: {
          itemId: id(event.itemId),
          how: event.how,
          ...(event.exitCode !== undefined ? { exitCode: event.exitCode } : {}),
          endedAt: event.endedAt ?? wall,
          ...(summary !== null ? { summary } : {}),
        },
      };
    }
  }
}

/** Строка истории агентов в журнал; уже записанная (`journaled`) — пропуск. */
export function journalAgentEvent(
  task: LiveTask,
  binding: SessionBinding,
  event: AgentEvent,
  wall: number,
  journaled: Set<string>,
): void {
  const row = rowOf(task, binding, event, wall);
  if (journaled.has(row.key)) return;
  const starts = bgStartsOf(task);
  if (row.kind === 'bg.ended') {
    // Начало без стены потока (запись без времени строк) записано стеной прикрепления: журнал
    // дописывается, начало уже не сдвинуть — конец не раньше него, иначе длительность меньше нуля.
    const itemKey = keyOf('bg', binding.sessionId, row.data.itemId);
    const start = starts.get(itemKey);
    starts.delete(itemKey);
    if (start !== undefined && row.data.endedAt < start) row.data = { ...row.data, endedAt: start };
  }
  task.append({
    kind: row.kind,
    actor: `session:${binding.sessionId}`,
    stepId: binding.stepId,
    sessionId: binding.sessionId,
    data: row.data,
  } as Parameters<LiveTask['append']>[0]);
  journaled.add(row.key);
  if (row.kind === 'bg.started')
    starts.set(keyOf('bg', binding.sessionId, row.data.itemId), row.data.startedAt);
}

/** Начала фона, записанные этим ядром (сессия + работа → стена начала), — до его конца. */
const BG_STARTS = new WeakMap<LiveTask, Map<string, number>>();
function bgStartsOf(task: LiveTask): Map<string, number> {
  let starts = BG_STARTS.get(task);
  if (!starts) {
    starts = new Map();
    BG_STARTS.set(task, starts);
  }
  return starts;
}
