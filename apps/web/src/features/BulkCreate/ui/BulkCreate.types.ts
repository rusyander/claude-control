import type { ReactNode } from 'react';

/**
 * Одна распознанная строка ввода. Если разбор не удался, строка помечается
 * ошибкой и в создание не идёт — но пользователь видит, что именно не так.
 */
export interface ParsedLine<TDraft> {
  raw: string;
  draft?: TDraft;
  error?: string;
}

export interface BulkCreateProps<TDraft> {
  /** Что создаём — в подписи и заголовке. */
  kindLabel: string;
  placeholder: string;
  /** Разбор одной строки в черновик. Пустые строки сюда не приходят. */
  parseLine: (line: string) => ParsedLine<TDraft>;
  /** Создание одного черновика. */
  createOne: (draft: TDraft) => Promise<unknown>;
  /** Как показать распознанную строку в превью. */
  renderPreview: (draft: TDraft) => ReactNode;
  /** Необязательные общие настройки над полем — например, выбор действия. */
  controls?: ReactNode;
  onDone: () => void;
}
