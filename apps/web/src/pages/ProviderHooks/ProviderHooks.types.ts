/**
 * Формы редактора хуков OpenCode. У каждой строки свой `id`, чтобы поля не
 * «прыгали» при вводе: без него React переиспользовал бы узлы по индексу, и
 * удаление строки посреди списка сбрасывало бы фокус и содержимое соседей.
 */

/** Один аргумент команды (argv-элемент). */
export interface ArgvRow {
  id: number;
  value: string;
}

/** Одна переменная окружения действия. */
export interface EnvRow {
  id: number;
  key: string;
  value: string;
}

/** Одно действие: список аргументов + переменные окружения. */
export interface ActionRow {
  id: number;
  command: ArgvRow[];
  env: EnvRow[];
}

/** Одна группа события `file_edited`: шаблон файлов и его действия. */
export interface PatternRow {
  id: number;
  pattern: string;
  actions: ActionRow[];
}

/** Состояние формы: оба события целиком. */
export interface HooksFormState {
  fileEdited: PatternRow[];
  sessionCompleted: ActionRow[];
}
