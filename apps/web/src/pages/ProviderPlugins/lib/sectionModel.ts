import type { ProviderInstalledPluginsProps } from '../ProviderInstalledPlugins/ProviderInstalledPlugins.types';

/**
 * Установленное у чужого CLI — две модели на одном экране, различает их
 * `installedActions` от сервера, а не имя провайдера.
 *
 * Kimi Code (KIMI-3) — ТОЛЬКО ПОКАЗ: список установленного и признак «включён»
 * лежат в `plugins/installed.json`, форма которого не описана, а ставят и
 * включают плагины командой `/plugins` внутри CLI. Кнопок записи нет.
 *
 * Qwen Code (MAP 25) — расширения: установить, включить, выключить, удалить.
 * Панель ничего не пишет сама, сервер зовёт `qwen extensions …`; `update` и
 * `link` всегда спрашивают [Y/n] в терминале, поэтому здесь их нет — пояснение
 * отсылает к терминалу.
 *
 * Codex (MAP 25) — плагины с рынков: рынки, «можно поставить», поставленные.
 * Ставит и удаляет `codex plugin …`, включение — строка `enabled` в config.toml.
 */
/** Модель раздела: Codex (рынки), Qwen (команды CLI) или Kimi (только показ). */
export function sectionModel(data: ProviderInstalledPluginsProps['data']): string {
  if (data.format === 'codex-plugins') return 'codex';
  return data.installedActions ? 'extensions' : 'installed';
}
