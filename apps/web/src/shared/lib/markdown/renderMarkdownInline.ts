import { markdown } from './renderMarkdown.constants';

/** Короткий фрагмент без блочных обёрток — для строки в списке. */
export function renderMarkdownInline(text: string): string {
  return markdown.renderInline(text);
}
