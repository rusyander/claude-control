import { join } from 'node:path';
import type { FormatCheckProvider, FormatCheckReport } from '@claude-control/contracts';
import { readJsonFile, writeJsonFile } from '../lib/safe-io.ts';

/**
 * Сверка форматов чужих CLI с их ОФИЦИАЛЬНЫМИ схемами (IDEA-3).
 *
 * ЗАЧЕМ. Панель пишет чужие конфигурации по документации, а документация уезжает
 * вместе с релизами CLI. Сегодня всё сходится, через два релиза ключ переехал — и
 * узнаёт об этом пользователь, у которого CLI перестал стартовать. Сверка задаёт
 * тот же вопрос заранее: ключи, которые панель РЕАЛЬНО правит, всё ещё есть в
 * опубликованной схеме?
 *
 * ЧЕГО НЕ ДЕЛАЕТ. Не придумывает адреса схем: у кого официальной схемы нет, у
 * того нет и проверки — так и написано (`no-schema`), а не «всё хорошо». Не
 * валидирует конфигурацию пользователя: сверяются НАШИ ключи со схемой, а не
 * чужой файл с чем-либо. Ничего не блокирует и не чинит: расхождение — повод
 * посмотреть глазами, а не основание перестать писать.
 *
 * Сеть трогается редко (раз в неделю или по кнопке) и никогда не на пути
 * пользователя: раздел отдаёт кэш, обновление идёт фоном.
 */

/**
 * Реестр сверки. ТОЛЬКО задокументированные адреса схем — выдумывать URL нельзя:
 * запрос не туда либо тихо провалится, либо (хуже) сверит нас с чужим файлом и
 * выдаст ложное «всё сходится».
 *
 * `keys` — ровно те пути, которые панель ПИШЕТ. Появился новый раздел у чужого
 * CLI → добавьте сюда его ключ, иначе сверка будет успокаивать зря.
 */
interface ProviderSchemaSpec {
  providerId: string;
  schemaUrl?: string;
  keys: Array<{ path: string; section: string }>;
  /** Почему схемы нет — текст показывается как есть. */
  noSchemaNote?: string;
}

const NO_SCHEMA = (file: string): string =>
  `Схема ${file} официально не публикуется — сверять не с чем.`;

export const FORMAT_CHECK_REGISTRY: readonly ProviderSchemaSpec[] = [
  {
    providerId: 'opencode',
    // Адрес указан в самой документации OpenCode и стоит в `$schema` их же
    // примеров конфигурации — то есть он официальный, а не угаданный.
    schemaUrl: 'https://opencode.ai/config.json',
    keys: [
      { path: 'mcp', section: 'mcp' },
      { path: 'permission', section: 'permissions' },
      { path: 'plugin', section: 'plugins' },
      // `experimental.hook` здесь БОЛЬШЕ НЕТ — и это результат работы самой
      // сверки. Первый же прогон (2026-07-25) показал, что ключ исчез из схемы, а
      // проверка по документации это подтвердила; раздел хуков переведён в чтение
      // (`writeDisabledReason` в catalog.ts), панель ключ не пишет. В реестре
      // перечисляется только то, что панель ПИШЕТ, иначе карточка вечно светила
      // бы расхождением, которое уже разобрано.
    ],
  },
  { providerId: 'codex', keys: [], noSchemaNote: NO_SCHEMA('config.toml') },
  { providerId: 'gemini', keys: [], noSchemaNote: NO_SCHEMA('settings.json') },
  { providerId: 'qwen', keys: [], noSchemaNote: NO_SCHEMA('settings.json') },
  { providerId: 'continue', keys: [], noSchemaNote: NO_SCHEMA('config.yaml') },
  { providerId: 'goose', keys: [], noSchemaNote: NO_SCHEMA('config.yaml') },
  { providerId: 'kimi', keys: [], noSchemaNote: NO_SCHEMA('config.toml') },
  { providerId: 'cursor', keys: [], noSchemaNote: NO_SCHEMA('cli-config.json') },
  { providerId: 'aider', keys: [], noSchemaNote: NO_SCHEMA('.aider.conf.yml') },
];

/** Неделя: схемы меняются с релизами CLI, чаще ходить незачем. */
export const FORMAT_CHECK_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/** Сеть не должна подвешивать раздел настроек. */
const FETCH_TIMEOUT_MS = 10_000;

const CACHE_FILE = 'format-check.json';

/**
 * Есть ли путь `a.b.c` в JSON Schema. Идём по `properties`, попутно раскрывая
 * локальные `$ref`, ветви `allOf`/`anyOf`/`oneOf` и `additionalProperties` как
 * схему свободной карты.
 *
 * Осторожность важнее полноты: не поняли схему — считаем ключ НЕ найденным и
 * говорим об этом. Ложная тревога стоит одного взгляда человека, пропущенное
 * расхождение — сломанной конфигурации у пользователя.
 */
export function schemaHasPath(schema: unknown, path: string): boolean {
  let current: unknown = schema;
  for (const segment of path.split('.')) {
    const next = propertySchema(schema, current, segment);
    if (!next) return false;
    current = next;
  }
  return true;
}

/** Схема свойства `key` внутри узла — или `undefined`, если такого свойства нет. */
function propertySchema(root: unknown, node: unknown, key: string): unknown {
  for (const candidate of expand(root, node)) {
    const record = candidate as Record<string, unknown>;

    const properties = record.properties;
    if (properties && typeof properties === 'object') {
      const found = (properties as Record<string, unknown>)[key];
      if (found !== undefined) return found;
    }

    // Свободная карта (`additionalProperties: {…}`): допустим любой ключ, значит
    // и наш тоже — дальше идём по её схеме.
    const additional = record.additionalProperties;
    if (additional && typeof additional === 'object') return additional;
  }
  return undefined;
}

/** Узел плюс все его ветви композиции и раскрытые ссылки, без циклов. */
function expand(root: unknown, node: unknown, seen = new Set<unknown>()): unknown[] {
  if (!node || typeof node !== 'object' || seen.has(node)) return [];
  seen.add(node);

  const record = node as Record<string, unknown>;
  const result: unknown[] = [record];

  const ref = record.$ref;
  if (typeof ref === 'string') {
    const target = resolveRef(root, ref);
    if (target) result.push(...expand(root, target, seen));
  }

  for (const key of ['allOf', 'anyOf', 'oneOf'] as const) {
    const branch = record[key];
    if (Array.isArray(branch)) {
      for (const item of branch) result.push(...expand(root, item, seen));
    }
  }

  return result;
}

/** Локальная ссылка `#/$defs/Имя` → узел схемы. Внешние ссылки не разрешаем. */
function resolveRef(root: unknown, ref: string): unknown {
  if (!ref.startsWith('#/')) return undefined;
  let node: unknown = root;
  for (const rawSegment of ref.slice(2).split('/')) {
    const segment = rawSegment.replace(/~1/g, '/').replace(/~0/g, '~');
    if (!node || typeof node !== 'object') return undefined;
    node = (node as Record<string, unknown>)[segment];
  }
  return node;
}

/** Свести схему и список ведомых ключей к итогу по провайдеру. */
export function checkSchema(spec: ProviderSchemaSpec, schema: unknown): FormatCheckProvider {
  const keys = spec.keys.map((key) => ({
    path: key.path,
    section: key.section,
    present: schemaHasPath(schema, key.path),
  }));
  return {
    providerId: spec.providerId,
    state: keys.some((key) => !key.present) ? 'drift' : 'ok',
    schemaUrl: spec.schemaUrl,
    keys,
  };
}

/** Загрузить и разобрать схему. Любая неудача — исключение для вызывающего. */
async function fetchSchema(url: string, fetchImpl: typeof fetch): Promise<unknown> {
  const response = await fetchImpl(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!response.ok) throw new Error(`схема недоступна: HTTP ${response.status}`);
  const schema = (await response.json()) as unknown;
  if (!schema || typeof schema !== 'object') throw new Error('ответ не похож на JSON Schema');
  return schema;
}

/**
 * Прогнать сверку по всему реестру. Провайдер без схемы отвечает `no-schema`
 * сразу, без запроса; неудача сети — `unavailable` у него одного, остальных она
 * не роняет.
 */
export async function runFormatCheck(
  now: () => Date = () => new Date(),
  fetchImpl: typeof fetch = fetch,
): Promise<FormatCheckReport> {
  const providers: FormatCheckProvider[] = [];

  for (const spec of FORMAT_CHECK_REGISTRY) {
    if (!spec.schemaUrl) {
      providers.push({
        providerId: spec.providerId,
        state: 'no-schema',
        keys: [],
        note: spec.noSchemaNote,
      });
      continue;
    }
    try {
      providers.push(checkSchema(spec, await fetchSchema(spec.schemaUrl, fetchImpl)));
    } catch (error) {
      providers.push({
        providerId: spec.providerId,
        state: 'unavailable',
        schemaUrl: spec.schemaUrl,
        keys: [],
        note: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return { checkedAt: now().toISOString(), providers };
}

/**
 * Кэш сверки в appData панели. Раздел НИКОГДА не ждёт сеть: отдаём то, что есть,
 * а устаревший результат обновляем фоном.
 */
export class FormatCheckStore {
  private readonly cacheFile: string;
  private report: FormatCheckReport | undefined;
  private refreshing: Promise<FormatCheckReport> | undefined;

  constructor(appDataDir: string) {
    this.cacheFile = join(appDataDir, CACHE_FILE);
    try {
      this.report = readJsonFile<FormatCheckReport | undefined>(this.cacheFile, undefined);
    } catch {
      // Битый кэш — не повод падать при старте: считаем, что сверки не было.
      this.report = undefined;
    }
  }

  /** Что известно сейчас. `undefined` — сверка ещё не выполнялась. */
  current(): FormatCheckReport | undefined {
    return this.report;
  }

  /** Результат устарел (или его нет вовсе). */
  isStale(now: () => Date = () => new Date()): boolean {
    if (!this.report) return true;
    const age = now().getTime() - Date.parse(this.report.checkedAt);
    return !Number.isFinite(age) || age > FORMAT_CHECK_MAX_AGE_MS;
  }

  /** Обновить принудительно — кнопка «проверить сейчас». */
  async refresh(
    now: () => Date = () => new Date(),
    fetchImpl: typeof fetch = fetch,
  ): Promise<FormatCheckReport> {
    // Параллельные запросы делят один поход в сеть.
    this.refreshing ??= runFormatCheck(now, fetchImpl)
      .then((report) => {
        this.report = report;
        try {
          writeJsonFile(this.cacheFile, report);
        } catch {
          // Кэш — ускорение, а не результат: не записался, значит в следующий раз
          // сходим в сеть заново.
        }
        return report;
      })
      .finally(() => {
        this.refreshing = undefined;
      });
    return this.refreshing;
  }

  /** Обновить, только если результат устарел; ошибку сети проглотить. */
  refreshIfStale(now: () => Date = () => new Date(), fetchImpl: typeof fetch = fetch): void {
    if (!this.isStale(now)) return;
    void this.refresh(now, fetchImpl).catch(() => undefined);
  }
}
