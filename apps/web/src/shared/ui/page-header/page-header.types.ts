import type { ReactNode } from 'react';

export interface PageHeaderProps {
  title: string;
  subtitle?: string;
  /** Кнопки действий раздела — обычно «создать» и «обновить». */
  actions?: ReactNode;
  /**
   * Идентификатор раздела справки. Если задан, рядом с заголовком появляется
   * значок «?», ведущий на подробный разбор: вопрос обычно возникает на самой
   * странице, а не в оглавлении справки.
   */
  helpTopic?: string;
}
