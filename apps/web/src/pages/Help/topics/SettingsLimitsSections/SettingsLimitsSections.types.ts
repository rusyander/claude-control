export interface SectionProps {
  /** Перевод ключа `help.topics.settings.<key>`. */
  tr: (key: string) => string;
  /** Общий ключ справки: `help.common.<key>`. */
  common: (key: string) => string;
  /** Название и краткое описание раздела «Контур» — ссылка ведёт в его документ. */
  platform: { title: string; summary: string };
}
