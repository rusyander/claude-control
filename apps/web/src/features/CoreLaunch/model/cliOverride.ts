import type { ConfigView, CoreConfig } from '@agentdeck/contracts/core/config';

/**
 * Явный путь к CLI переходника в настройке ядра (F9): раздел `cliPaths` — переходник → путь к
 * исполняемому файлу, выигрывает у поиска. Ядро читает его при каждом запуске сессии и каждой
 * предпроверке дороги `cli`. Запись — `POST /v1/config` (`set-config`, строгий суд полномочий):
 * настройка машинная, шире любой задачи. Путь только абсолютный — относительный схема отвергнет.
 */

export function cliPathOf(view: ConfigView | undefined, adapter: string): string | null {
  return view?.doc.cliPaths?.[adapter] ?? null;
}

/**
 * Новый документ настройки с путём CLI переходника. Пустой путь — переопределение снято (поиск
 * снова решает сам); пустой раздел уходит из документа целиком. Документ — весь действующий, с
 * отпечатком (`baseDigest`): чужая запись между чтением и сохранением — 409, а не затирание.
 */
export function withCliPath(
  view: ConfigView,
  adapter: string,
  path: string,
): { doc: CoreConfig; baseDigest: string } {
  const doc: CoreConfig = { ...view.doc };
  const paths = { ...(doc.cliPaths ?? {}) };
  const clean = path.trim();
  if (clean) paths[adapter] = clean;
  else delete paths[adapter];
  if (Object.keys(paths).length > 0) doc.cliPaths = paths;
  else delete doc.cliPaths;
  return { doc, baseDigest: view.digest };
}
