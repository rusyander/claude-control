/**
 * Раздел «Плагины» у НЕ-Claude провайдера (OPENCODE-4).
 *
 * Раздел «Плагины» Claude — это каталог расширений САМОЙ панели (`domains/
 * plugins.ts`, маршруты `/api/plugins`). Он не меняется: здесь речь о плагинах
 * чужого CLI, и модель другая.
 *
 * У OpenCode плагины подключаются ДВУМЯ задокументированными способами, и панель
 * ведёт оба:
 *
 *  1. **ФАЙЛЫ ПЛАГИНОВ** — модули JS/TS, которые OpenCode подхватывает при старте
 *     из каталога `~/.config/opencode/plugins/` (глобально) и
 *     `<проект>/.opencode/plugins/` (в проекте). Это тот же случай, что каталог
 *     правил Cursor (CURSOR-1), поэтому менеджер списан с него один-в-один,
 *     ВКЛЮЧАЯ защиту путей.
 *  2. **NPM-ПАКЕТЫ** — массив `plugin` в `opencode.json`. Ключ подтверждён
 *     документацией и опубликованной схемой конфигурации (см. `lib/
 *     opencode-plugin.ts`), поэтому список читается И правится.
 *
 * БЕЗОПАСНОСТЬ ПУТЕЙ — как у правил Cursor. Клиент присылает путь ОТНОСИТЕЛЬНО
 * каталога плагинов, и он обязан разрешаться ВНУТРИ него. Отклоняются: пустое
 * имя, `..`/`.`/пустой сегмент, абсолютный путь (в т.ч. `C:\…` и `\\сервер\шара`),
 * нулевой байт, расширение не из белого списка, а также путь, любой сегмент
 * которого — символическая ссылка. Отказ = 400 `unsafe_path` ВСЕГДА, никогда 404:
 * существует ли файл за пределами каталога — не наше дело сообщать. Одинаково на
 * чтении, записи и удалении.
 *
 * FAIL-CLOSED: каталог не читается → файловая половина только для чтения; конфиг
 * не разбирается → список npm только для чтения (422 на запись), файл не тронут.
 * Каталог создаётся ТОЛЬКО при явном сохранении файла.
 *
 * Файл — вход раздела: разбор по модулям лежит в `provider-plugins/`
 * (`paths.ts` — цель и защита путей, `files.ts` — файловая половина,
 * `packages.ts` — npm-список, `installed.ts` — установленное у Kimi, `info.ts` —
 * сводка, `errors.ts` — отказы и их коды).
 */
export type { ProviderPluginsTarget } from './provider-plugins/types.ts';
export {
  UnsafePluginPathError,
  PluginFileNotFoundError,
  PluginFileNotEditableError,
  describePluginError,
} from './provider-plugins/errors.ts';
export {
  OPENCODE_PLUGIN_EXTENSIONS,
  resolveProviderPluginsTarget,
  resolvePluginPath,
} from './provider-plugins/paths.ts';
export { readProviderPluginsInfo } from './provider-plugins/info.ts';
export {
  readProviderPluginFile,
  parseProviderPluginFileDraft,
  saveProviderPluginFile,
  deleteProviderPluginFile,
} from './provider-plugins/files.ts';
export {
  parseProviderPluginPackagesDraft,
  saveProviderPluginPackages,
} from './provider-plugins/packages.ts';
