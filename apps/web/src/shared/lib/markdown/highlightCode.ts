import { languageOf } from './languageOf';

/**
 * Подсветка кода для предпросмотра артефактов. Shiki грузит грамматики по
 * требованию, поэтому подсветка асинхронная: до её готовности показывается
 * обычный моноширинный текст, и страница не ждёт загрузки языка.
 *
 * Само ядро Shiki тоже едет отдельным чанком при первой подсветке: из
 * `shiki/langs` статически берётся только карта языков (ссылки на грамматики),
 * а не движок с темами — иначе он сидел бы в главном чанке ради предпросмотра.
 */

const THEMES = { light: 'github-light', dark: 'github-dark' } as const;

export async function highlightCode(
  code: string,
  fileName: string,
  theme: 'light' | 'dark',
): Promise<string> {
  const { codeToHtml } = await import('shiki');
  return codeToHtml(code, { lang: languageOf(fileName), theme: THEMES[theme] });
}
