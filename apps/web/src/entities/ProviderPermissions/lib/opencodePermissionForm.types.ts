import type { OpencodePermissionLevel } from '@agentdeck/contracts';

/** Значение селекта инструмента: «не задано», уровень или список шаблонов. */
export type OpencodeToolChoice = 'unset' | OpencodePermissionLevel | 'patterns';

/** Строка списка шаблонов в форме (`id` нужен, чтобы строки не «прыгали» при вводе). */
export interface OpencodePatternRow {
  id: number;
  pattern: string;
  level: OpencodePermissionLevel;
}

export interface OpencodeFormState {
  choices: Record<string, OpencodeToolChoice>;
  patterns: OpencodePatternRow[];
}
