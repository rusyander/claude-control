import { bundledLanguages } from 'shiki/langs';

/** Язык определяем по расширению — в артефактах это единственная подсказка. */
export const LANGUAGE_BY_EXTENSION: Record<string, string> = {
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
