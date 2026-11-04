import type { TaskFoldState } from '../../journal/reduce/reduce.types.ts';
import type { SafepointDecision, SafepointInput } from './safepoint.types.ts';

/**
 * Единственный судья класса `safepoint` (P01): сессию снимают на паузе или меняют ей сценарий
 * только здесь. Открытый инструмент — правка на полпути; проверка в работе — её запись пропадёт
 * вместе с деревом; середина хода — модель думает, снятие оборвёт мысль без итога.
 */
export function decideSafepoint(input: SafepointInput): SafepointDecision {
  const reasons: string[] = [];
  if (input.toolsOpen > 0) reasons.push(`${input.toolsOpen} tool call(s) open`);
  if (input.checksInFlight > 0) reasons.push(`${input.checksInFlight} check run(s) in flight`);
  if (!input.atTurnEnd) reasons.push('turn in progress');
  return { safe: reasons.length === 0, reasons: reasons.length ? reasons : ['at turn end, idle'] };
}

const IN_FLIGHT = new Set(['queued', 'leased', 'running']);

/** Прогоны проверок единицы, которые ещё идут: снятие сессии их не должно обрывать. */
export function checksInFlight(state: TaskFoldState, unitId: string): number {
  return Object.values(state.checks).filter((c) => IN_FLIGHT.has(c.state) && c.run?.unit === unitId)
    .length;
}
