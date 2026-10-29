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
}

/** Свои настройки переходнику по его id (подставной CLI, частота опроса); прочим — по умолчанию. */
export function createAdapterRegistry(
  options: Record<string, AdapterOptions> = {},
): AdapterRegistry {
  const adapters = new Map<string, CliAdapter>();
  for (const make of FACTORIES) {
    const plain = make();
    const own = options[plain.id];
    adapters.set(plain.id, own ? make(own) : plain);
  }
  return {
    get: (id) => adapters.get(id),
    ids: () => [...adapters.keys()],
    all: () => [...adapters.values()],
  };
}
