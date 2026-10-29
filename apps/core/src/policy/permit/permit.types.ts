import type { DenySet } from '../../adapters/adapter.types.ts';

/** Маски с операциями — форма `grantRequired` и гранта задачи (06 §grantRequired). */
export interface GlobOps {
  globs: readonly string[];
  ops: readonly ('edit' | 'exec-db')[];
}

/** Типизированные факты, по которым решает `policy/permit` (06 §Session permissions). */
export interface PermitContext {
  /** Корень копии единицы (длинная настоящая форма). */
  copyRoot: string;
  /** Свои пути единицы от корня копии; пусто — вся копия своя (одиночная задача). */
  ownedPaths: readonly string[];
  /** Запреты платформы: инструменты MCP, префиксы argv публикации. */
  deny: DenySet;
  /** Дом ядра и файлы токенов: ни чтения, ни правки, человек этого не разрешает. */
  platformPaths: readonly string[];
  /** Файлы, где профиль нашёл постоянный адрес сервиса: чтение — точка человека 3. */
  endpointSources: readonly string[];
  grantRequired: readonly GlobOps[];
  /** Гранты ЭТОЙ задачи (живое решение человека; в следующую задачу не переходят). */
  grants: readonly GlobOps[];
  /**
   * Что читается вне копии (F-87). Нет поля — только копия: чтение вне неё отказывается, а не
   * разрешается молча. Собирает `buildReadScope` (`read-scope-build.ts`).
   */
  readScope?: ReadScope;
}

/** Область чтения сеанса вне копии (06 §Session permissions, решение владельца F-87). */
export interface ReadScope {
  /** Кеши зависимостей и инструменты (`platform/toolchain-roots.ts`), каталоги слоя CLI. */
  roots: readonly string[];
  /**
   * Расширение человека для проекта: только из конфига ядра или команды человека — никогда из
   * файлов репозитория и не инструментом модели. Несводимая запись ничего не открывает.
   */
  human: readonly string[];
  /**
   * Временный каталог сеанса (TMPDIR CLI): читается, даже если лежит в доме ядра, — но только
   * пока в нём самом нет пути платформы.
   */
  ownTemp?: string;
  /** Файлы учётных данных CLI: закрыты и внутри разрешённого каталога, и для оболочки. */
  credentials: readonly string[];
  /** Бюджет обхода ссылок под корнем поиска (записей); нет — `LINK_SCAN_BUDGET` платформы. */
  scanBudget?: number;
}

/** Входы чистого сборщика области чтения: каждый факт — от своего владельца. */
export interface ReadScopeInput {
  /** Корень копии: от него разрешаются относительные записи человека. */
  copyRoot: string;
  /** Временный каталог сеанса (тот, что получил CLI как TMPDIR/TEMP/TMP). */
  sessionTemp?: string;
  /** Каталоги слоя CLI только для чтения и его файлы учётных данных — факты переходника. */
  layer: { dirs: readonly string[]; credentials: readonly string[] };
  /** Корни кешей и инструментов — факты платформы (`toolchainReadRoots`). */
  toolchainRoots: readonly string[];
  /** Список человека (конфиг ядра / команда человека). */
  humanAllow: readonly string[];
}

/** Запись, которую сборщик не принял, и почему (человеку — в ответ на его команду). */
export interface ReadScopeRefusal {
  entry: string;
  reason: string;
}

export type PermitRefusal =
  /** Правка вне копии; чтение вне копии и вне области чтения (`readScope`, F-87). */
  | 'outside-copy'
  /** Файл учётных данных CLI (или поиск над ним) — чтением и словом команды (F-87). */
  | 'credential-path'
  | 'denied-tool'
  | 'platform-step'
  | 'platform-path'
  | 'endpoint-source'
  | 'grant-required'
  | 'read-only-step'
  | 'git-internals'
  /** Правка `<копия>/.claude/**`: настройки и хуки CLI — граница права сессии (F-12). */
  | 'cli-config'
  /** Правка под путём из `deny.editPaths` сеанса — того же списка, что получил оверлей CLI. */
  | 'denied-path'
  /** Команда, которую разбор не прошёл до конца или которая может оказаться публикацией. */
  | 'publish-unknown'
  | 'unknown-action';

export type PermitDecision =
  | { allow: true; signal: 'ownership' | null; reason: string }
  | { allow: false; code: PermitRefusal; reason: string; humanPoint: 3 | 5 | null };

/** Кодек вопроса о праве — факт CLI, живёт у переходника (`CliAdapter.permitCodec`). */
export type { PermitCodec } from '../../adapters/adapter.types.ts';
