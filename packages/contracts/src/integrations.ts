/**
 * Внешние интеграции панели: Jira и Confluence, форджи по токену, Telegram,
 * тест-менеджмент в Jira (Zephyr/Xray) и подхват отчётов CI.
 *
 * Один принцип на весь файл: НАСТРОЙКА живёт в настройках панели и видна, ТОКЕН
 * живёт в зашифрованном хранилище (`lib/provider-keys.ts`) и наружу уходит
 * только маской. Поэтому здесь нет ни одного поля, куда мог бы попасть секрет.
 *
 * Здесь только типы: значения (zod-схемы) — в `app-settings.ts`, иначе сервер с
 * `--experimental-strip-types` упадёт на импорте значения из общего бочонка.
 */

/** Какой Atlassian на том конце: облако или своя установка. */
export type AtlassianDeployment = 'cloud' | 'server';

export interface AtlassianSettings {
  enabled: boolean;
  /** `https://site.atlassian.net` для облака, свой адрес для Server/DC. */
  baseUrl: string;
  /** Облако: почта для Basic-авторизации. Server/DC: пусто, там Bearer. */
  email: string;
  /** Пусто = определить живой проверкой и запомнить, что ответил сервер. */
  deployment: AtlassianDeployment | '';
  /** Отдельный адрес Confluence, если он живёт не на хосте Jira. */
  confluenceUrl: string;
}

/** Фордж по токену — дефекты и связь с MR без установленных `gh`/`glab`. */
export interface ForgeSettings {
  enabled: boolean;
  kind: 'github' | 'gitlab' | '';
  /** Свой GitLab: адрес инсталляции. Пусто = github.com / gitlab.com. */
  baseUrl: string;
  /** `owner/repo` или числовой id проекта GitLab; пусто = вывести из origin. */
  repo: string;
}

export type TelegramEvent = 'runDone' | 'runError' | 'permission' | 'question' | 'testFailed';

export interface TelegramSettings {
  enabled: boolean;
  /** Куда слать: id чата или канала (`@name` тоже принимается). */
  chatId: string;
  events: TelegramEvent[];
}

/** Тест-менеджмент в Jira. Место истины по кейсам остаётся там, а не в панели. */
export interface TmsSettings {
  enabled: boolean;
  kind: 'zephyr' | 'xray' | '';
  /** Ключ проекта Jira, в котором лежат кейсы и циклы. */
  projectKey: string;
  /** Группа панели, с которой синхронизируется проект; пусто = спрашивать. */
  groupId: string;
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
  atlassian: AtlassianSettings;
  forge: ForgeSettings;
  telegram: TelegramSettings;
  tms: TmsSettings;
  ci: CiSettings;
}

export type IntegrationId = keyof IntegrationsSettings;

/** Итог последней живой проверки связи — то же, что панель хранит по MCP. */
export type IntegrationState = 'ok' | 'error' | 'unchecked';

export interface IntegrationStatus {
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
}

/** Итог отправки прогона в тест-менеджмент. */
export interface TmsPushResult {
  pushed: number;
  /** Ссылка на цикл/выполнение, если система её вернула. */
  url?: string;
}
