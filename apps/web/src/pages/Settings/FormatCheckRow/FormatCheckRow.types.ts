import type { FormatCheckProvider } from '@agentdeck/contracts';

export interface FormatCheckRowProps {
  row: FormatCheckProvider;
  /** Человекочитаемое имя CLI: в отчёте лежит только идентификатор. */
  name: string;
}
