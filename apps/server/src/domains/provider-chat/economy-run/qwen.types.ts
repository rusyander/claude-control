/**
 * Как Qwen Code входит в модель (`security.auth.selectedType` бандла): срок кэша
 * задаётся только при `anthropic`. Строка — у CLI появляются новые виды входа, и
 * незнакомый вид не должен ломать прогон.
 */
export type QwenAuthType =
  'anthropic' | 'openai' | 'qwen-oauth' | 'gemini' | 'vertex-ai' | (string & Record<never, never>);

/**
 * Запись модели хода из `modelProviders` слитых настроек, которую Qwen применит
 * (`resolveCliGenerationConfig` бандла). Есть запись — её `generationConfig` главнее
 * ключа верхнего уровня целиком: `window` — её `contextWindowSize` как есть
 * (`undefined` — ключа в записи нет, и Qwen берёт окно из своей таблицы).
 */
export interface QwenProviderEntry {
  window?: unknown;
  /** Ключ окна в записи задан (даже негодным значением). */
  hasWindow: boolean;
  /** Адрес записи: есть — он главнее переменной окружения и `security.auth.baseUrl`. */
  baseUrl?: string;
}

/** Откуда искать запись: слитые настройки и то, как Qwen пойдёт в модель. */
export interface QwenProviderLookup {
  modelProviders: unknown;
  providerProtocol: unknown;
  auth: QwenAuthType | undefined;
  /** Модель хода: флаг `--model`, иначе `model.name` настроек, иначе переменная входа. */
  model: string | undefined;
  /** Сохранённый `model.baseUrl` — только когда модель взята из `model.name`. */
  persistedBaseUrl?: string;
}

/** Что рычаги экономии группы меняют в системных настройках Qwen на один прогон. */
export interface QwenEconomyPatch {
  /**
   * `context.autoCompactThreshold` — доля окна модели, вниз до 4 знаков; 0 < x <
   * порога без рычага (ключ человека или 0,85 CLI), значит и 0 < x < 1.
   */
  autoCompactThreshold?: number;
  /** `tools.truncateToolOutputThreshold` — предел ответа любого инструмента, знаки. */
  truncateToolOutputThreshold?: number;
  /** `ide.enabled` — `false`, когда рычаг отвязки редактора включён. */
  ideEnabled?: false;
  /** `model.generationConfig.cacheRetention` — '1h' только при входе через Anthropic. */
  cacheRetention?: '1h';
}
