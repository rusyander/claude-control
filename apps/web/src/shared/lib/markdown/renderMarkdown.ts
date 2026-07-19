import MarkdownIt from 'markdown-it';

/**
 * Разметка ответов и markdown-артефактов.
 *
 * Текст приходит от модели, а не от нас, поэтому html в исходнике отключён:
 * иначе ответ мог бы протащить в страницу произвольную разметку. Ссылки
 * открываются в новой вкладке — уводить пользователя из чата незачем.
 */
const markdown = new MarkdownIt({
  html: false,
  linkify: true,
  breaks: true,
});

const defaultLinkOpen =
  markdown.renderer.rules.link_open ??
  ((tokens, index, options, _env, self) => self.renderToken(tokens, index, options));

markdown.renderer.rules.link_open = (tokens, index, options, env, self) => {
  tokens[index]?.attrSet('target', '_blank');
  tokens[index]?.attrSet('rel', 'noreferrer noopener');
  return defaultLinkOpen(tokens, index, options, env, self);
};

export function renderMarkdown(text: string): string {
  return markdown.render(text);
}

/** Короткий фрагмент без блочных обёрток — для строки в списке. */
export function renderMarkdownInline(text: string): string {
  return markdown.renderInline(text);
}
