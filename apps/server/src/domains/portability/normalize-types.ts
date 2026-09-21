import type { EnvOrigin, EnvSource } from '@agentdeck/contracts/portable-env';

/**
 * Фабрика происхождения записи: нормализатор знает вид записи и вид
 * происхождения, но не знает ни провайдера, ни уровня, ни файла — их подставляет
 * импортёр, который один и владеет этим знанием.
 *
 * Отдельный тип, а не четыре аргумента в каждой функции: иначе `provider` и
 * `scope` протаскивались бы через каждый нормализатор и рано или поздно
 * разъехались бы между ними.
 */
export type EnvSourceFactory = (origin: EnvOrigin, file?: string | null) => EnvSource;

/**
 * Собрать фабрику для одного файла-источника.
 *
 * Четвёртый аргумент — плагин, принёсший записи: он задаётся НА ФАБРИКУ, а не на
 * вызов, потому что плагин раскладывается на обычные записи целым набором
 * (П2.6), и пометить происхождением половину из них нельзя.
 */
export function sourceFactory(
  provider: string,
  scope: EnvSource['scope'],
  defaultFile: string | null,
  plugin: string | null = null,
) {
  return (origin: EnvOrigin, file?: string | null): EnvSource => ({
    provider,
    scope,
    origin,
    file: file === undefined ? defaultFile : file,
    plugin,
  });
}
