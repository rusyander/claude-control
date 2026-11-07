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
  /**
   * Режим навыков человека в сеансе (06:115). Нет поля — фактов слоя нет: вызов навыка
   * отказывается, как до этапа 7.
   */
  layer?: { skills: 'on' | 'off' };
  /**
   * Подагенты CLI (06:124, G5): пущены ли (`caps.subagentHooks` доказан), потолок модели и ранг
   * модели вызова — «правила модели человека только понижают». Нет поля — подагент отказывается.
   */
  subagents?: {
    allowed: boolean;
    /**
     * Ранг потолка: потолок задачи, иначе названная модель сеанса (03:147 — модель человека и есть
     * потолок). `null` — ранга нет: потолок не назван или не на лестнице.
     */
    ceilingRank: number | null;
    /**
     * Потолок не назван (сеанс на модели CLI по умолчанию): модель, которую CLI сам назвал для ЭТОГО
     * сеанса (`sessions[id].modelServed` журнала), и её ранг — читается в момент суда, имя приходит
     * после старта. `null` — CLI ещё ничего не назвал. Нет поля — потолок назван (`ceilingRank`).
     */
    reportedCeiling?(): { model: string; rank: number | null } | null;
    /**
     * Потолок так и не известен (не назван, CLI не назвал или имени нет на лестнице): `true` — чат
     * без потолка задачи пускает названную модель с рангом, причина говорит, что потолка нет;
     * нет или `false` — отказ `subagent-model-unknown` (единица задачи).
     */
    openWithoutCeiling?: boolean;
    /** Ранг модели по имени; `null` — модель неизвестна реестру. */
    modelRank(model: string): number | null;
    /**
     * Модель определения подагента из описи слоя (`agents[].model`); `null`/`inherit` или нет
     * определения — модель сеанса. Нет поля — определений не знаем, судится только модель вызова.
     */
    definitionModel?(subagentType: string): string | null;
    /**
     * Запрет правки и оболочки держится и внутри подагента (проба L Q5: `--disallowedTools` и
     * вопрос права у подагента Claude). Нет или `false` — на шаге только для чтения подагент отказан.
     */
    readOnlyHolds?: boolean;
    /**
     * Сеанс единицы задачи под ведением (этап 11, P141): работник ведущего — подагента не зовёт,
     * дробит работу ведущий. Сеанс чата под это не попадает. Нет или `false` — правила нет.
     */
    leadWorker?: boolean;
  };
  /**
   * Границы сеанса от вызывающего (`task.created.session.scope`, этап 10 F6): правка — только под
   * масками `edit` от корня, команды с префиксом argv из `denyCommands` — отказ. Нет поля — границ
   * сверх платформы нет. Перенос гейта прежнего прогона тестов панели (`decidePermission`).
   */
  scope?: {
    edit: readonly string[];
    denyCommands: readonly (readonly string[])[];
  };
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
  /**
   * Копии вложений человека этой задачи (s10 G11): каталог в доме ядра, читается — на тех же
   * условиях, что `ownTemp`: только пока в нём самом нет пути платформы.
   */
  attachments?: string;
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
  /** Каталог копий вложений задачи (`conductor/attachments`) — факт задачи. */
  taskAttachments?: string;
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
  /** Инструмент записи (или не доказанного чтения) сервера форжа человека — `forge-mcp-read-only`. */
  | 'forge-mcp-write'
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
  /** Навык человека, когда навыки сеанса выключены (или фактов слоя нет). */
  | 'skills-off'
  /** Подагент, когда проба не доказала, что хук ядра и запреты держатся внутри него (G5). */
  | 'subagent-unproven'
  /** Модель подагента выше потолка: правила модели человека только понижают (06:124). */
  | 'model-above-ceiling'
  /** Ранг модели подагента или потолка неизвестен — сравнить нечем, отказ с именем (F25). */
  | 'subagent-model-unknown'
  /** Подагент из сеанса единицы под ведением (этап 11, P141): работу дробит ведущий. */
  | 'lead-worker'
  /** Правка вне `scope.edit` сеанса (этап 10, F6). */
  | 'outside-scope'
  /** Команда с префиксом из `scope.denyCommands` сеанса (этап 10, F6). */
  | 'scope-command'
  | 'unknown-action';

export type PermitDecision =
  | { allow: true; signal: 'ownership' | null; reason: string }
  | { allow: false; code: PermitRefusal; reason: string; humanPoint: 3 | 5 | null };

/** Кодек вопроса о праве — факт CLI, живёт у переходника (`CliAdapter.permitCodec`). */
export type { PermitCodec } from '../../adapters/adapter.types.ts';
