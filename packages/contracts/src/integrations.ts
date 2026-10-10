/**
 * Внешние интеграции панели: Jira, Confluence, GitLab, GitHub, Telegram,
 * системы тест-кейсов (Zephyr, Xray, Test IT), подхват отчётов CI и вебхук.
 *
 * Каждая система — СВОЯ интеграция со своим тумблером, адресом и ключом
 * (владелец 10.10.2026): захотел — подключил, отключение одной не трогает
 * другие. Раньше Jira и Confluence жили одной связкой, а GitHub и GitLab —
 * одной карточкой с выбором вида, и подключить оба форджа сразу было нельзя.
 *
 * Один принцип на весь файл: НАСТРОЙКА живёт в настройках панели и видна, ТОКЕН
 * живёт в зашифрованном хранилище (`lib/provider-keys/provider-keys.ts`) и наружу уходит
 * только маской. Поэтому здесь нет ни одного поля, куда мог бы попасть секрет.
 *
 * Здесь только типы: значения (zod-схемы) — в `app-settings.ts`, иначе сервер с
 * `--experimental-strip-types` упадёт на импорте значения из общего бочонка.
 */

import type { CodedFields } from './server-messages.ts';

/** Какой Atlassian на том конце: облако или своя установка. */
export type AtlassianDeployment = 'cloud' | 'server';

/** Jira или Confluence: у каждой свой адрес, своя почта и свой ключ. */
export interface AtlassianSiteSettings {
  enabled: boolean;
  /**
   * Jira: `https://site.atlassian.net` или свой адрес. Confluence: адрес вики —
   * у облака `https://site.atlassian.net/wiki`, у своей установки свой хост.
   */
  baseUrl: string;
  /** Облако: почта для Basic-авторизации. Server/DC: пусто, там Bearer. */
  email: string;
  /** Пусто = определить живой проверкой и запомнить, что ответил сервер. */
  deployment: AtlassianDeployment | '';
}

export type JiraSettings = AtlassianSiteSettings;
export type ConfluenceSettings = AtlassianSiteSettings;

/** GitLab или GitHub по токену — дефекты и связь с MR без установленных `gh`/`glab`. */
export interface ForgeSiteSettings {
  enabled: boolean;
  /** Своя инсталляция: её адрес. Пусто = github.com / gitlab.com. */
  baseUrl: string;
  /** `owner/repo` или числовой id проекта GitLab; пусто = вывести из origin. */
  repo: string;
}

export type ForgeKind = 'github' | 'gitlab';

/** Фордж с видом — то, с чем работает клиент форджа на сервере. */
export interface ForgeSettings extends ForgeSiteSettings {
  kind: ForgeKind | '';
}

/**
 * События панели, на которые можно подписаться наружу — ОДИН список на все
 * схемы. Значение, а не только тип: то же перечисление нужно и схеме настроек,
 * и схеме импорта на сервере, а четыре списанные друг с друга копии уже
 * разъехались — `budget` добавили в две из них, и собственный снимок панели
 * перестал импортироваться обратно.
 */
export const NOTIFY_EVENTS = [
  'runDone',
  'runError',
  'permission',
  'question',
  'testFailed',
  /**
   * Бюджет контура: наша оценка расхода перешла порог внимания или дошла до
   * введённого бюджета. Одно событие на оба порога — подписка отвечает на
   * вопрос «сообщать ли про бюджет», а не «про какой именно порог»; какой
   * именно, сказано в тексте.
   */
  'budget',
] as const;

/** Событие панели, на которое можно подписаться наружу. */
export type NotifyEvent = (typeof NOTIFY_EVENTS)[number];

/** Прежнее имя того же списка: подписка у Telegram и у вебхука одна и та же. */
export type TelegramEvent = NotifyEvent;

export interface TelegramSettings {
  enabled: boolean;
  /** Куда слать: id чата или канала (`@name` тоже принимается). */
  chatId: string;
  events: TelegramEvent[];
}

/**
 * Вебхук: те же события, но своим адресом.
 *
 * Существует потому, что Telegram закрывает ровно одного адресата, а спрашивают
 * про Slack, Mattermost, дежурного бота и внутреннюю шину. Один POST с JSON
 * закрывает их все, и панели не нужно знать ни одного из них.
 *
 * Секрет подписи живёт в зашифрованном хранилище рядом с прочими токенами: если
 * он задан, тело подписывается заголовком `X-AgentDeck-Signature`
 * (HMAC-SHA256, hex) — иначе приёмник не отличит панель от любого, кто узнал
 * адрес.
 */
export interface WebhookSettings {
  enabled: boolean;
  /** Куда слать POST с JSON. Только http(s). */
  url: string;
  events: NotifyEvent[];
}

/** Тело вебхука. Ровно то же, что уходит в Telegram, — заголовок без содержимого. */
export interface WebhookPayload {
  event: NotifyEvent;
  /** Текст события по-русски — тот же, что читает человек в Telegram. */
  text: string;
  /** Имя папки проекта; у домашнего чата пусто. */
  project?: string;
  /** Момент отправки, ISO. */
  at: string;
}

/**
 * Какая система тест-менеджмента на том конце.
 *
 * Две первые живут в Jira и в облаке по фиксированному адресу; Test IT ставят
 * себе, и адрес у каждой компании свой — поэтому `baseUrl` ниже.
 */
export type TmsKind = 'zephyr' | 'xray' | 'testit';

/**
 * Одна система тест-кейсов. Место истины по кейсам остаётся там, а не в
 * панели. Каждая подключается сама по себе: Zephyr у одной команды и Test IT у
 * другой живут рядом.
 */
export interface TmsSystemSettings {
  enabled: boolean;
  /**
   * Адрес своей установки. Нужен только Test IT: у Zephyr и Xray API общий на
   * всех, и поле у них не читается вовсе.
   */
  baseUrl: string;
  /** Ключ проекта Jira или идентификатор проекта Test IT. */
  projectKey: string;
  /** Группа панели, с которой синхронизируется проект; пусто = спрашивать. */
  groupId: string;
}

/** Система тест-кейсов с видом — то, с чем работает её клиент на сервере. */
export interface TmsSettings extends TmsSystemSettings {
  kind: TmsKind | '';
}

/** Откуда панель сама забирает отчёт последнего прогона CI. */
export interface CiSettings {
  enabled: boolean;
  kind: 'github' | 'gitlab' | '';
  /** `owner/repo` или id проекта; пусто = вывести из origin проверяемого проекта. */
  repo: string;
  /** Имя workflow/job; пусто = последний завершившийся прогон. */
  workflow: string;
  /** Имя артефакта или путь к отчёту внутри него. */
  artifact: string;
}

export interface IntegrationsSettings {
  jira: JiraSettings;
  confluence: ConfluenceSettings;
  gitlab: ForgeSiteSettings;
  github: ForgeSiteSettings;
  telegram: TelegramSettings;
  zephyr: TmsSystemSettings;
  xray: TmsSystemSettings;
  testit: TmsSystemSettings;
  ci: CiSettings;
  webhook: WebhookSettings;
}

export type IntegrationId = keyof IntegrationsSettings;

/** Порядок карточек — он же порядок в ответе `GET /api/integrations`. */
export const INTEGRATION_ORDER = [
  'jira',
  'confluence',
  'gitlab',
  'github',
  'telegram',
  'zephyr',
  'xray',
  'testit',
  'ci',
  'webhook',
] as const satisfies readonly IntegrationId[];

/** Как запущен найденный MCP-сервер. */
export type DiscoveredLaunch = 'docker' | 'npx' | 'uvx' | 'url' | 'command';

/**
 * Интеграция, найденная среди MCP-серверов человека (`Найти уже подключённые`).
 *
 * Ключа здесь нет и быть не может — только маска: значение остаётся на
 * сервере, и подтверждение переноса называет кандидата по `key`, а сервер
 * заново читает ключ из того же источника.
 */
export interface DiscoveredIntegration {
  /** Кандидат целиком: по нему человек подтверждает перенос. */
  key: string;
  id: IntegrationId;
  /** Имя MCP-сервера, как оно записано в конфигурации. */
  server: string;
  /** Где описан сервер: `~/.claude.json` (общий или проектный блок) или `.mcp.json`. */
  source: 'user' | 'project' | 'mcp-json';
  /** Проект — для `project` и `mcp-json`. */
  project?: string;
  launch: DiscoveredLaunch;
  /** Пакет, образ или адрес, по которому система узнана. */
  package: string;
  /** Видимые поля, которые лягут в настройку интеграции (адрес, почта, чат). */
  fields: Record<string, string>;
  hasToken: boolean;
  maskedToken: string;
  /** Чего в найденном не хватает для работы: `baseUrl`, `token`, `chatId`. */
  missing: string[];
  /** Интеграция уже подключена ровно с этим адресом и этим ключом. */
  alreadyConnected: boolean;
  /** Перенос заменит уже сохранённый другой ключ или адрес. */
  replaces: boolean;
}

export interface IntegrationDiscovery {
  found: DiscoveredIntegration[];
  /** Сколько MCP-серверов просмотрено — «ничего не нашли» среди скольких. */
  scanned: number;
}

/** Итог последней живой проверки связи — то же, что панель хранит по MCP. */
export type IntegrationState = 'ok' | 'error' | 'unchecked';

export interface IntegrationStatus extends CodedFields<'detail'> {
  id: IntegrationId;
  enabled: boolean;
  /** Есть ли сохранённый токен. Сам токен наружу не отдаётся никогда. */
  hasToken: boolean;
  /** `abc…4f21` — чтобы человек узнал свой ключ, не увидев его. */
  maskedToken: string;
  state: IntegrationState;
  /** Человеческая причина отказа или короткое «кем вошли». */
  detail: string;
  checkedAt?: string;
  /** Кем панель представилась серверу: имя учётной записи. */
  account?: string;
  /** Что ответил Atlassian на вопрос о себе: облако или своя установка. */
  deployment?: AtlassianDeployment;
}

export interface JiraProject {
  id: string;
  key: string;
  name: string;
}

export interface JiraIssue {
  key: string;
  summary: string;
  status: string;
  /**
   * Куда статус относится по мнению самой Jira: `new`, `indeterminate`, `done`.
   *
   * Названия статусов у каждой команды свои («Готово», «Verified», «Закрыт»), и
   * судить о закрытости по строке — гадание. Категорию Jira считает сама, и
   * только по ней панель имеет право сказать «дефект закрыт».
   */
  statusCategory?: 'new' | 'indeterminate' | 'done';
  type: string;
  assignee?: string;
  updatedAt?: string;
  url: string;
  /** Тело задачи в тексте; у облака ADF разворачивается в plain. */
  description?: string;
}

export interface JiraTransition {
  id: string;
  name: string;
  /**
   * Статус, в который переход ведёт. Имя перехода у команды своё («Отдать в
   * тест»), а человек выбирает статус («Ready for Test») — сверять надо с ним.
   */
  to?: string;
}

export interface ConfluenceSpace {
  id: string;
  key: string;
  name: string;
}

export interface ConfluencePage {
  id: string;
  title: string;
  spaceKey: string;
  url: string;
  version?: number;
  /** Тело страницы: storage-формат для записи, текст для чтения. */
  body?: string;
}

/**
 * Внешний контекст, привязанный человеком: куда заводить дефекты, где лежат
 * требования, куда публиковать отчёт. Это то, чего агент сам знать не может, —
 * и именно это уходит ему строкой в задании.
 */
export interface IntegrationLink {
  /** Проект Jira для новых дефектов. */
  jiraProjectKey?: string;
  /** Задача-эпик или тикет, к которому относится работа. */
  jiraIssueKey?: string;
  jiraIssueTitle?: string;
  /** Страница Confluence: и требования, и место для отчёта. */
  confluencePageId?: string;
  confluencePageTitle?: string;
  /** Репозиторий форджа, если он не выводится из origin. */
  forgeRepo?: string;
  /** Пояснение человека: что именно тут лежит. */
  note?: string;
}

/** Привязки одного проверяемого проекта: сам проект и его группы тестов. */
export interface IntegrationLinks {
  project: IntegrationLink;
  groups: Record<string, IntegrationLink>;
}

/** Ответ на публикацию отчёта прогона наружу. */
export interface IntegrationPublishResult {
  url: string;
  /** Что именно случилось: страница создана или обновлена. */
  created: boolean;
}

/**
 * Куда панель умеет завести дефект по проваленному кейсу.
 *
 * `github`/`gitlab` — это `gh`/`glab`, уже стоящие у человека: они работают без
 * единого секрета в панели и потому остаются запасным путём навсегда. `forge` —
 * тот же фордж, но по СОХРАНЁННОМУ токену: он есть там, где CLI не поставить.
 * `jira` — трекер, в котором дефект и живёт у команды.
 *
 * Тип объявлен здесь, а не рядом с остальным тестовым хозяйством, потому что
 * два новых значения существуют ровно из-за интеграций: без токена их не бывает.
 */
export type DefectTarget = 'github' | 'gitlab' | 'forge' | 'jira';

/**
 * Черновик дефекта вместе с тем, куда его можно отправить прямо сейчас.
 *
 * Отдельная форма, а не расширение `ProjectTestDefectDraft`: у того список
 * назначений закрыт двумя CLI, и подменять его значение было бы враньём для
 * всех, кто читает старое поле.
 */
export interface DefectDraft {
  title: string;
  body: string;
  targets: DefectTarget[];
  /** Чем именно это будет сделано — `gh`, `glab` или имя подключённой системы. */
  hint?: string;
}

/** Итог забора кейсов из тест-менеджмента в группу панели. */
export interface TmsPullResult {
  imported: number;
  /** Кейсы, которые уже были в группе и остались как есть. */
  skipped: number;
  /**
   * Список кейсов на той стороне упёрся в потолок панели, и привезено НЕ ВСЁ.
   * Молчать об этом нельзя: «привезено 2000» человек читает как «это все кейсы
   * проекта» и не узнает, что остальных просто не запрашивали.
   */
  truncated?: boolean;
}

/** Итог отправки прогона в тест-менеджмент. */
export interface TmsPushResult {
  pushed: number;
  /** Ссылка на цикл/выполнение, если система её вернула. */
  url?: string;
  /**
   * Ключ цикла/рана на той стороне. Панель запоминает его в записи прогона,
   * и повторная отправка того же прогона попадает в ТОТ ЖЕ ран.
   */
  runId?: string;
  /** Отправка легла в уже существующий ран, а не завела новый. */
  reused?: boolean;
  /**
   * Внешние ключи кейсов прогона, которых на той стороне не нашлось. Отправку
   * это не отменяет: из-за одной устаревшей пометки терять весь прогон незачем.
   * Но и пропасть молча они не должны — иначе неполный ран читается как полный.
   */
  missing?: string[];
}
