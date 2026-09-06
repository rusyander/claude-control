import { bundledLanguages } from 'shiki/langs';

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

/** Язык определяем по расширению — в артефактах это единственная подсказка. */
const LANGUAGE_BY_EXTENSION: Record<string, string> = {
  js: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  ts: 'typescript',
  tsx: 'tsx',
  jsx: 'jsx',
  py: 'python',
  sh: 'bash',
  ps1: 'powershell',
  html: 'html',
  htm: 'html',
  css: 'css',
  scss: 'scss',
  json: 'json',
  yml: 'yaml',
  yaml: 'yaml',
  md: 'markdown',
  sql: 'sql',
  csv: 'csv',
};

export function languageOf(fileName: string): string {
  const extension = fileName.split('.').pop()?.toLowerCase() ?? '';
  const language = LANGUAGE_BY_EXTENSION[extension] ?? extension;
  return language in bundledLanguages ? language : 'text';
}

export async function highlightCode(
  code: string,
  fileName: string,
  theme: 'light' | 'dark',
): Promise<string> {
  const { codeToHtml } = await import('shiki');
  return codeToHtml(code, { lang: languageOf(fileName), theme: THEMES[theme] });
}
