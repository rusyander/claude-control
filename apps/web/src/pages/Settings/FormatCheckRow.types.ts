import type { FormatCheckProvider } from '@claude-control/contracts';

export interface FormatCheckRowProps {
  row: FormatCheckProvider;
  /** Человекочитаемое имя CLI: в отчёте лежит только идентификатор. */
  name: string;
}
