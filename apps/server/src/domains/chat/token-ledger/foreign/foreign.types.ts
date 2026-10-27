import type { WatchEvent } from '../watch/watch.types.ts';

/** Чья переписка: у Codex и Qwen Code свои форматы файла сессии. */
export type ForeignTranscriptKind = 'codex' | 'qwen';

/**
 * Чьи имена инструментов приводятся к именам Claude: у Gemini CLI переписки нет,
 * есть поток; у OpenCode — база сессий.
 */
export type ForeignToolDialect = ForeignTranscriptKind | 'gemini' | 'opencode';

/** Читатель одной строки переписки (разобранный JSON) → события сторожа. */
export type ForeignRowReader = (row: unknown) => WatchEvent[];

/** Читатель документа: весь документ → события, ещё не отданные сторожу. */
export type ForeignDocumentReader = (doc: unknown, now: number) => WatchEvent[];

/**
 * Откуда документ сессии: файл JSON (Continue) или запись базы (OpenCode). `ref` —
 * путь файла или ссылка на сессию в базе; сторож хранит его как путь переписки.
 */
export interface ForeignDocumentSource {
  /** Отпечаток: сдвинулся ли документ с прошлого чтения; нет документа — `undefined`. */
  stamp(ref: string): { mtimeMs: number; size: number } | undefined;
  /** Когда документ родился, мс эпохи; неизвестно — `undefined`. */
  bornAt(ref: string): number | undefined;
  /** Документ целиком; недописан, чужой или его нет — `undefined`. */
  load(ref: string): unknown;
}

/** Что решению «продолжить или начать заново» нужно знать о сессии CLI. */
export interface ForeignWarmth {
  /** Время последней записи файла сессии, мс эпохи; нет времени в строках — время файла. */
  lastAt: number;
  /** Окно последнего вызова модели; 0 — неизвестно. */
  contextTokens: number;
  /** Окно первого вызова — база, с которой начал бы новый разговор; 0 — неизвестно. */
  freshBase: number;
}
