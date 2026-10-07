/** Путь файла плагина выходит за пределы каталога — операция запрещена. */
export class UnsafePluginPathError extends Error {
  readonly path: string;

  constructor(path: string, detail: string) {
    super(`Путь плагина «${path}» отклонён: ${detail}`);
    this.name = 'UnsafePluginPathError';
    this.path = path;
  }
}

/** Файла плагина с таким путём в каталоге нет. */
export class PluginFileNotFoundError extends Error {
  readonly path: string;

  constructor(path: string) {
    super(`Файл плагина «${path}» не найден в каталоге плагинов.`);
    this.name = 'PluginFileNotFoundError';
    this.path = path;
  }
}

/** Файл есть, но панель его не открывает (слишком большой, не текст). */
export class PluginFileNotEditableError extends Error {
  readonly path: string;

  constructor(path: string, message: string) {
    super(message);
    this.name = 'PluginFileNotEditableError';
    this.path = path;
  }
}

/** Источник расширения Qwen не годится в аргумент `qwen extensions install`. */
export class InvalidExtensionSourceError extends Error {
  constructor() {
    super(
      'Источник расширения не прошёл проверку: одна строка до 1000 символов, не начинается с «-».',
    );
    this.name = 'InvalidExtensionSourceError';
  }
}

/** Расширения с таким именем среди установленных нет. */
export class QwenExtensionNotFoundError extends Error {
  readonly extension: string;

  constructor(extension: string) {
    super(`Расширение «${extension}» не установлено.`);
    this.name = 'QwenExtensionNotFoundError';
    this.extension = extension;
  }
}

/** CLI не запустился (нет в PATH и т.п.). */
export class QwenCliUnavailableError extends Error {
  constructor(reason: string) {
    super(`Qwen Code CLI не запустился: ${reason}`);
    this.name = 'QwenCliUnavailableError';
  }
}

/** CLI запустился и отказал — `reason` — его собственные слова. */
export class QwenCliFailedError extends Error {
  readonly reason: string;

  constructor(reason: string) {
    super(`Qwen Code отказал: ${reason}`);
    this.name = 'QwenCliFailedError';
    this.reason = reason;
  }
}

/** Селектор плагина Codex не похож на `имя@рынок`. */
export class InvalidCodexPluginSelectorError extends Error {
  constructor() {
    super('Плагин Codex называется как имя@рынок: одна строка без пробелов, не начинается с «-».');
    this.name = 'InvalidCodexPluginSelectorError';
  }
}

/** Источник рынка не годится в аргумент `codex plugin marketplace add`. */
export class InvalidCodexMarketplaceSourceError extends Error {
  constructor() {
    super('Источник рынка не прошёл проверку: одна строка до 1000 символов, не начинается с «-».');
    this.name = 'InvalidCodexMarketplaceSourceError';
  }
}

/** Плагина с таким id среди поставленных нет. */
export class CodexPluginNotFoundError extends Error {
  readonly plugin: string;

  constructor(plugin: string) {
    super(`Плагин «${plugin}» не установлен.`);
    this.name = 'CodexPluginNotFoundError';
    this.plugin = plugin;
  }
}

/** Рынка с таким именем среди подключённых нет. */
export class CodexMarketplaceNotFoundError extends Error {
  readonly marketplace: string;

  constructor(marketplace: string) {
    super(`Рынок «${marketplace}» не подключён.`);
    this.name = 'CodexMarketplaceNotFoundError';
    this.marketplace = marketplace;
  }
}

/** CLI Codex не запустился (нет в PATH и т.п.). */
export class CodexCliUnavailableError extends Error {
  constructor(reason: string) {
    super(`Codex CLI не запустился: ${reason}`);
    this.name = 'CodexCliUnavailableError';
  }
}

/** CLI Codex запустился и отказал — `reason` — его собственные слова. */
export class CodexCliFailedError extends Error {
  readonly reason: string;

  constructor(reason: string) {
    super(`Codex отказал: ${reason}`);
    this.name = 'CodexCliFailedError';
    this.reason = reason;
  }
}

/**
 * Разложить отказ домена в код ответа и тело — одинаково для глобального и
 * проектного маршрутов. `undefined` для ошибок, которые маршрут пробрасывает.
 *
 * Небезопасный путь — всегда 400 `unsafe_path`, НИКОГДА 404.
 */
export function describePluginError(
  error: unknown,
): { status: number; body: Record<string, unknown> } | undefined {
  if (error instanceof UnsafePluginPathError) {
    return { status: 400, body: { error: 'unsafe_path', message: error.message } };
  }
  if (error instanceof PluginFileNotFoundError) {
    return { status: 404, body: { error: 'not_found', message: error.message } };
  }
  if (error instanceof PluginFileNotEditableError) {
    return { status: 422, body: { error: 'plugin_read_only', message: error.message } };
  }
  if (error instanceof InvalidExtensionSourceError) {
    return {
      status: 400,
      body: {
        error: 'invalid_source',
        message: error.message,
        messageCode: 'qwen-extension-source-invalid',
      },
    };
  }
  if (error instanceof QwenExtensionNotFoundError) {
    return {
      status: 404,
      body: {
        error: 'not_found',
        message: error.message,
        messageCode: 'qwen-extension-not-found',
        params: { name: error.extension },
      },
    };
  }
  if (error instanceof QwenCliUnavailableError) {
    return {
      status: 503,
      body: {
        error: 'cli_unavailable',
        message: error.message,
        messageCode: 'qwen-cli-unavailable',
      },
    };
  }
  if (error instanceof QwenCliFailedError) {
    return {
      status: 422,
      body: {
        error: 'cli_failed',
        message: error.message,
        messageCode: 'qwen-extension-cli-failed',
        params: { reason: error.reason },
      },
    };
  }
  if (error instanceof InvalidCodexPluginSelectorError) {
    return {
      status: 400,
      body: {
        error: 'invalid_source',
        message: error.message,
        messageCode: 'codex-plugin-selector-invalid',
      },
    };
  }
  if (error instanceof InvalidCodexMarketplaceSourceError) {
    return {
      status: 400,
      body: {
        error: 'invalid_source',
        message: error.message,
        messageCode: 'codex-marketplace-source-invalid',
      },
    };
  }
  if (error instanceof CodexPluginNotFoundError) {
    return {
      status: 404,
      body: {
        error: 'not_found',
        message: error.message,
        messageCode: 'codex-plugin-not-found',
        params: { name: error.plugin },
      },
    };
  }
  if (error instanceof CodexMarketplaceNotFoundError) {
    return {
      status: 404,
      body: {
        error: 'not_found',
        message: error.message,
        messageCode: 'codex-marketplace-not-found',
        params: { name: error.marketplace },
      },
    };
  }
  if (error instanceof CodexCliUnavailableError) {
    return {
      status: 503,
      body: {
        error: 'cli_unavailable',
        message: error.message,
        messageCode: 'codex-cli-unavailable',
      },
    };
  }
  if (error instanceof CodexCliFailedError) {
    return {
      status: 422,
      body: {
        error: 'cli_failed',
        message: error.message,
        messageCode: 'codex-plugin-cli-failed',
        params: { reason: error.reason },
      },
    };
  }
  return undefined;
}
