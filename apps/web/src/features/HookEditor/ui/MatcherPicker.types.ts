export interface MatcherPickerProps {
  value: string[];
  onChange: (matchers: string[]) => void;
  /** Инструменты, которые чаще всего фильтруют для этого события. */
  suggestions: readonly string[];
}
