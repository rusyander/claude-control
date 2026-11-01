import type { CliAdapter } from './adapter.types.ts';
import { createClaudeAdapter } from './claude/claude.ts';
import { createQwenAdapter } from './qwen/qwen.ts';
import type { SdkAdapterOptions } from './sdk-stream/sdk-adapter.ts';

/**
 * Реестр переходников (03 §CLI adapter): части ядра получают переходник только отсюда, по id
 * решения compat — имён CLI вне `adapters/<cli>/` нет (P108). Новый CLI — новая папка и
 * строка в `FACTORIES`; его возможности объявляет он сам, набор соответствия проверяет каждую.
 */

export type * from './adapter.types.ts';
export { READ_ONLY_DENIED } from './read-only.ts';

export type AdapterOptions = SdkAdapterOptions;

const FACTORIES: readonly ((options?: AdapterOptions) => CliAdapter)[] = [
  createClaudeAdapter,
  createQwenAdapter,
];

export interface AdapterRegistry {
  get(id: string): CliAdapter | undefined;
  ids(): string[];
  all(): CliAdapter[];
  /**
   * Что искать предпроверке дороги `cli` (F9): явный путь из настройки ядра, иначе имя образа
   * CLI. `undefined` — переходника нет в сборке. Нет метода — реестр без настройки (проверки).
   */
  cliOf?(id: string): string | undefined;
}

export interface AdapterRegistryOptions {
  /** Явный путь CLI переходника из настройки ядра (`cliPaths`); читается на каждом обращении. */
  cliPathOf?: (adapterId: string) => string | undefined;
}

/** Свои настройки переходнику по его id (подставной CLI, частота опроса); прочим — по умолчанию. */
export function createAdapterRegistry(
  options: Record<string, AdapterOptions> = {},
  registry: AdapterRegistryOptions = {},
): AdapterRegistry {
  const { cliPathOf } = registry;
  const adapters = new Map<string, CliAdapter>();
  for (const make of FACTORIES) {
    const plain = make();
    const own = options[plain.id];
    // Запуск сессии и предпроверка читают один и тот же путь — расхождения «нашли / запустили
    // другой файл» не бывает.
    const commandOf = cliPathOf ? () => cliPathOf(plain.id) : undefined;
    adapters.set(
      plain.id,
      own || commandOf ? make({ ...own, ...(commandOf ? { commandOf } : {}) }) : plain,
    );
  }
  return {
    get: (id) => adapters.get(id),
    ids: () => [...adapters.keys()],
    all: () => [...adapters.values()],
    cliOf: (id) => {
      const adapter = adapters.get(id);
      if (!adapter) return undefined;
      return cliPathOf?.(id) ?? adapter.images[0];
    },
  };
}
