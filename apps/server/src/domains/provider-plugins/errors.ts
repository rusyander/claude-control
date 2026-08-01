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
  return undefined;
}
