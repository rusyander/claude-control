/**
 * Плагины активного провайдера (OpenCode, OPENCODE-4).
 *
 * Это НЕ раздел «Плагины» самой панели (`entities/Plugin`, `/api/plugins`) — тот
 * не тронут. Здесь плагины чужого CLI: каталог файлов JS/TS (список, чтение,
 * создание/обновление, удаление) и отдельно список npm-пакетов `plugin` в
 * `opencode.json`.
 *
 * Проектный уровень — те же данные по другому адресу.
 */

export interface Scope {
  /** Задан → каталог и конфиг проекта, иначе глобальные. */
  projectId?: string;
}

/** Ответ действия над расширением: последние строки, что сказал CLI. */
export interface ProviderExtensionActionResult {
  ok: true;
  output: string;
  needsRestart: true;
}

/** Ответ действия над рынком: последние строки CLI; перезапуск не нужен. */
export interface ProviderMarketplaceActionResult {
  ok: true;
  output: string;
  needsRestart: false;
}
