import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { JournalLine } from '@agentdeck/contracts/core/journal';

/**
 * Строки журнала живого прогона «субагент + фоновая оболочка» (этап 11, шов I1 → I2): запись
 * `agents-probe.jsonl` (Claude Code 2.1.310 на заглушке, `claude.agents.live.integration.test.ts`),
 * проигранная НАСТОЯЩИМИ нормализатором, рантаймом сессии и кранами в журнал задачи
 * (`agent-events.test.ts` сверяет их с этим файлом и перезаписывает при `AGENTS_JOURNAL_WRITE=1`).
 * Id задачи, шага, единицы и сессии — заглушки `<taskId>` / `<stepId>` / `<unitId>` / `<sessionId>`:
 * свёртка подставляет свои (`agentsJournalRows`) и дописывает строки в свою задачу `task.append`.
 */

export const AGENTS_JOURNAL = fileURLToPath(new URL('./agents-journal.jsonl', import.meta.url));

/** Виды строк, которые пишет поток сессии (остальное — посев задачи, у свёртки он свой). */
export const STREAM_KINDS: ReadonlySet<string> = new Set([
  'tool.started',
  'tool.event',
  'agent.spawned',
  'agent.ended',
  'bg.started',
  'bg.ended',
  'turn.usage',
  'turn.cli-initiated',
]);

export interface AgentsJournalIds {
  taskId: string;
  stepId: string;
  unitId: string;
  sessionId: string;
}

/** Строка для `task.append`: вид, автор, привязка и данные, как их записал прогон. */
export interface AgentsJournalRow {
  kind: string;
  actor: string;
  stepId?: string;
  sessionId?: string;
  data: Record<string, unknown>;
}

const SLOTS: readonly (keyof AgentsJournalIds)[] = ['taskId', 'stepId', 'unitId', 'sessionId'];

/** Строки потока из журнала задачи → вид файла (id → заглушки). */
export function toFixture(lines: readonly JournalLine[], ids: AgentsJournalIds): string {
  const rows = lines
    .filter((l) => STREAM_KINDS.has(l.kind))
    .map((l) => ({
      kind: l.kind,
      actor: l.actor,
      ...(l.stepId ? { stepId: l.stepId } : {}),
      ...(l.sessionId ? { sessionId: l.sessionId } : {}),
      data: l.data,
    }));
  let text = rows.map((r) => JSON.stringify(r)).join('\n');
  for (const slot of SLOTS) text = text.split(ids[slot]).join(`<${slot}>`);
  return `${text}\n`;
}

export function writeAgentsJournal(text: string): void {
  writeFileSync(AGENTS_JOURNAL, text);
}

export function readAgentsJournal(): string {
  return readFileSync(AGENTS_JOURNAL, 'utf8');
}

/** Строки файла со своими id — для `task.append` в задачу свёртки. */
export function agentsJournalRows(ids: AgentsJournalIds): AgentsJournalRow[] {
  let text = readAgentsJournal();
  for (const slot of SLOTS) text = text.split(`<${slot}>`).join(ids[slot]);
  return text
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((l) => JSON.parse(l) as AgentsJournalRow);
}
