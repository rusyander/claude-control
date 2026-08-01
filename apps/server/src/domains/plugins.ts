/**
 * Работа с плагинами через штатный CLI Claude Code. Установка плагина —
 * это клонирование репозитория маркетплейса и обновление нескольких файлов
 * состояния; воспроизводить это своими руками нельзя, иначе состояние
 * разъедется с тем, что видит сам Claude Code.
 *
 * Модули: `plugins/cli.ts` — запуск CLI, `plugins/read.ts` — каталоги
 * установленного и доступного, `plugins/actions.ts` — операции над плагинами и
 * маркетплейсами, `plugins/scaffold.ts` + `plugins/templates.ts` — каркас нового
 * плагина.
 */

export {
  addMarketplace,
  disablePlugin,
  enablePlugin,
  installPlugin,
  removeMarketplace,
  uninstallPlugin,
  updatePlugin,
} from './plugins/actions.ts';
export { readAvailablePlugins, readPlugins } from './plugins/read.ts';
export { pluginSlug, scaffoldPlugin } from './plugins/scaffold.ts';
