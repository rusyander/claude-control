import { CLI_LITERALS, type CliLiterals } from '@agentdeck/providers/literals';
import type { LiteralRule, LiteralRuleSet } from './literal-lint.ts';

/**
 * P108 (11 R:PR-08): имена CLI, их вендоров, бинарей, переменных окружения, семейств моделей,
 * псевдонимы моделей Claude и приставки id маршрутов живут только в переходниках (`adapters/`)
 * и маршрутах (`routes/`). Остальное ядро (дирижёр, политика, хост сессии, журнал, платформа)
 * перебирает реестр и никого не называет. Список не ведётся руками: правила строятся из
 * `CLI_LITERALS` реестра — новый CLI попадает под набор сам.
 *
 * Сравнение строк — по ЦЕЛОЙ строке (`'claude'`, `'gemini.cmd'`), а не по слову внутри текста:
 * фраза в сообщении или путь с этим словом — не развилка по имени. Переменные окружения и
 * приставки семейств ловятся и внутри строки — у них нет «случайного» значения.
 *
 * Этот файл — единственный вне разрешённых папок, кто знает литералы (он их и превращает в
 * правила), поэтому он в исключениях набора; сообщения правил литералов не содержат.
 */

const TEST_FILES = ['\\.test\\.ts$', '(^|/)__fixtures__/'];

/** Виды маршрутов (`RouteKind` шва): id маршрута — `<вид>:<имя>`. */
export const ROUTE_ID_PREFIXES = ['cli-login', 'api-key', 'local', 'gateway', 'stub'] as const;

const escape = (value: string): string => value.replace(/[.*+?^${}()|[\]\\/-]/g, '\\$&');
const alternatives = (values: readonly string[]): string =>
  // Пустой список не совпадает ни с чем: `^()\b` поймал бы любую строку.
  values.length === 0
    ? '(?!)'
    : // Длинные раньше коротких: `gemini-flash-lite` не съедается `gemini-flash`.
      [...values]
        .sort((a, b) => b.length - a.length || a.localeCompare(b))
        .map(escape)
        .join('|');

export function p108Rules(literals: CliLiterals): LiteralRule[] {
  return [
    {
      id: 'adapter-id',
      in: 'strings',
      pattern: `^(${alternatives(literals.adapterIds)})$`,
      message: 'a CLI is named only inside its adapter and the routes; iterate the registry.',
    },
    {
      id: 'vendor-name',
      in: 'strings',
      pattern: `^(${alternatives(literals.vendorNames)})$`,
      message: 'a model vendor is named only by the adapters and routes that serve it.',
    },
    {
      id: 'binary-name',
      in: 'strings',
      pattern: `^(${alternatives(literals.binaryNames)})$`,
      flags: 'i',
      message: 'a CLI binary is resolved from the registry run facts, not named.',
    },
    {
      id: 'env-var',
      in: 'strings',
      pattern: `\\b(${alternatives(literals.envVarNames)})\\b`,
      message: 'a CLI environment variable is written only by its adapter channel.',
    },
    {
      id: 'env-var-member',
      in: 'code',
      pattern: `\\.\\s*(${alternatives(literals.envVarNames)})\\b`,
      message: 'a CLI environment variable is read only by its adapter channel.',
    },
    {
      id: 'model-family',
      in: 'strings',
      pattern: `^(${alternatives(literals.modelFamilyPrefixes)})\\b`,
      message: 'a model family belongs to the adapter model ladder.',
    },
    {
      id: 'model-alias',
      in: 'strings',
      // Алиасы и приставки полных имён — ступени модели фактов CLI (`modelRungs`), не список здесь.
      pattern: `^(${alternatives(literals.modelAliases)})(\\b|$)`,
      message: 'a model alias of one CLI belongs to that adapter.',
    },
    {
      id: 'route-id',
      in: 'strings',
      pattern: `^(${alternatives(ROUTE_ID_PREFIXES)}):`,
      message: 'a route is found through the route registry, never by a written id.',
    },
    {
      id: 'providers-import',
      in: 'code',
      pattern: `['"]@agentdeck/providers(/[^'"]*)?['"]`,
      message: 'the CLI registry is imported only by adapters and routes.',
    },
  ];
}

/**
 * Разрешённые папки ровно по спеке (11 §Code shape, P108): `adapters/<cli>/` каждого CLI реестра,
 * `routes/<вид>/` каждого вида маршрута и `routes/{compat, hops}`. Общие части слоя (`launcher`,
 * `sdk-stream`, `deny-overlay`, реестр и адрес маршрутов) перебирают реестр и никого не называют
 * (F-94: раньше разрешался весь `adapters/` и весь `routes/`). `hop-host/` — процесс звена за
 * `routes/hops` (11 §Hop chain): переводит протоколы вендоров, их имена там — сам протокол.
 */
export function p108Allowed(literals: CliLiterals): string[] {
  return [
    ...literals.adapterIds.map((id) => `adapters/${id}`),
    ...ROUTE_ID_PREFIXES.map((kind) => `routes/${kind}`),
    'routes/compat',
    'routes/hops',
    'hop-host',
  ];
}

export const P108_CLI_NAMES: LiteralRuleSet = {
  id: 'P108',
  spec: '11-providers R:PR-08, CLI names only in adapters/<cli> and routes/<kind>',
  allowed: p108Allowed(CLI_LITERALS),
  exempt: [...TEST_FILES, '^literal-lint/p108\\.ts$'],
  rules: p108Rules(CLI_LITERALS),
};
