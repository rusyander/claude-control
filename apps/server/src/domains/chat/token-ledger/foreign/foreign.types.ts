import type { WatchEvent } from '../watch/watch.types.ts';

/** Чья переписка: у Codex и Qwen Code свои форматы файла сессии. */
export type ForeignTranscriptKind = 'codex' | 'qwen';

/** Читатель одной строки переписки (разобранный JSON) → события сторожа. */
export type ForeignRowReader = (row: unknown) => WatchEvent[];

/** Что решению «продолжить или начать заново» нужно знать о сессии CLI. */
export interface ForeignWarmth {
  /** Время последней записи файла сессии, мс эпохи; нет времени в строках — время файла. */
  lastAt: number;
  /** Окно последнего вызова модели; 0 — неизвестно. */
  contextTokens: number;
  /** Окно первого вызова — база, с которой начал бы новый разговор; 0 — неизвестно. */
  freshBase: number;
}
