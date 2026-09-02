import { object, string, array, enum as zodEnum, type infer as Infer } from 'zod';

/**
 * Глобальный поиск по всем разделам конфигурации: одна строка ищет по правилам,
 * скиллам, хукам, скриптам, правам, переменным, MCP-серверам и плагинам. Сервер
 * агрегирует разделы через их же читалки и фильтрует по запросу — клиент только
 * группирует результат по разделам и ведёт на нужную сущность.
 *
 * Поиск идёт по разделам АКТИВНОГО провайдера — иначе результат вёл бы на
 * страницу, скрытую гейтингом. Claude активен → всё как прежде; выбран другой
 * провайдер → ищем в его файлах (инструкции AGENTS.md/GEMINI.md, MCP-серверы,
 * переменные окружения, права) — но только в разделах со статусом `ready`.
 *
 * Секреты не ищутся и не показываются НИКОГДА: у переменных окружения в индекс
 * попадает только имя ключа, а файл `.mcp-secrets.env`, хранилище ключей
 * провайдеров (`provider-keys.enc`) и его машинный секрет (`provider-keys.key`)
 * в поиск не входят вовсе.
 */

/**
 * Раздел, из которого пришёл результат. Шире EntityKind: сюда входят ещё скрипты,
 * переменные, плагины и файл глобальных инструкций провайдера (`instructions` —
 * AGENTS.md/GEMINI.md; у Claude содержимое CLAUDE.md уже покрыто разделом `rule`,
 * поэтому дубля не создаём).
 */
export const searchResultKindSchema = zodEnum([
  'rule',
  'skill',
  'hook',
  'script',
  'permission',
  'env',
  'mcp',
  'plugin',
  'instructions',
  /** Группа панели — надстройка, файлов Claude Code у неё нет, но раздел на странице есть. */
  'group',
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
