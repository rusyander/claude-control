import { object, string, array, enum as zodEnum, type infer as Infer } from 'zod';

/**
 * Глобальный поиск по всем разделам конфигурации: одна строка ищет по правилам,
 * скиллам, хукам, скриптам, правам, переменным, MCP-серверам и плагинам. Сервер
 * агрегирует разделы через их же читалки и фильтрует по запросу — клиент только
 * группирует результат по разделам и ведёт на нужную сущность.
 */

/** Раздел, из которого пришёл результат. Шире EntityKind: сюда входят ещё скрипты, переменные и плагины. */
export const searchResultKindSchema = zodEnum([
  'rule',
  'skill',
  'hook',
  'script',
  'permission',
  'env',
  'mcp',
  'plugin',
]);

export type SearchResultKind = Infer<typeof searchResultKindSchema>;

export const searchResultSchema = object({
  /** Из какого раздела результат — по нему клиент группирует и подбирает иконку. */
  kind: searchResultKindSchema,
  /** Идентификатор сущности внутри раздела — уходит в адрес `?id=…`. */
  id: string(),
  /** Заголовок результата: имя правила, сервера, ключ переменной и т.п. */
  title: string(),
  /**
   * Короткий фрагмент с местом совпадения. Для переменных окружения это ТОЛЬКО
   * имя ключа — значение секрета в сниппет не попадает никогда.
   */
  snippet: string(),
  /**
   * Путь страницы раздела без ведущего слэша (`rules`, `mcp`, `env`). Клиент
   * открывает `/<pagePath>?id=<id>` — там, где страница поддерживает `?id=`,
   * сущность открывается сразу.
   */
  pagePath: string(),
});

export type SearchResult = Infer<typeof searchResultSchema>;

export const searchResponseSchema = object({
  /** Нормализованный запрос (обрезанный) — эхом, чтобы клиент мог сверить актуальность. */
  query: string(),
  results: array(searchResultSchema),
});

export type SearchResponse = Infer<typeof searchResponseSchema>;
