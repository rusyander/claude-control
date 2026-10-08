import type { KimiDecision } from '@agentdeck/contracts';

/** Строка формы: `id` нужен, чтобы строки не «прыгали» при вводе. */
export interface KimiRuleRow {
  id: number;
  decision: KimiDecision;
  pattern: string;
}
