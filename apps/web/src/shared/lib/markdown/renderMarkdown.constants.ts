import MarkdownIt from 'markdown-it';

/**
 * Разметка ответов и markdown-артефактов.
 *
 * Текст приходит от модели, а не от нас, поэтому html в исходнике отключён:
 * иначе ответ мог бы протащить в страницу произвольную разметку. Ссылки
 * открываются в новой вкладке — уводить пользователя из чата незачем.
 */
export const markdown = new MarkdownIt({
  html: false,
  linkify: true,
  breaks: true,
});
