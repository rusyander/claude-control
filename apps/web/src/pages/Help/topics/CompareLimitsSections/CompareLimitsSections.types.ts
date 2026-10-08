export interface SectionProps {
  /** Перевод ключа `help.topics.compare.<key>`. */
  tr: (key: string) => string;
  /** Общий ключ справки: `help.common.<key>`. */
  common: (key: string) => string;
}
