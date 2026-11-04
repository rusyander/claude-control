import type {
  AppSettings,
  AtlassianSiteSettings,
  ForgeSiteSettings,
  IntegrationId,
  IntegrationsSettings,
  TelegramEvent,
  TmsSystemSettings,
} from '@agentdeck/contracts';
import { INTEGRATION_ORDER } from '@agentdeck/contracts/integrations';

/**
 * Настройки внешних интеграций, прочитанные из общих настроек панели.
 *
 * Читаем защищённо, с умолчаниями на каждое поле, и вот почему: настройки —
 * ОДИН файл на диске, который панель могла записать любой прошлой версией, а
 * секция интеграций появилась позже всего остального. Полагаться на её наличие
 * значит уронить весь раздел настроек на конфиге, заведённом вчера. То же
 * защищает от неполной секции: связка «Jira есть, Confluence нет» — обычное
 * состояние на середине настройки, а не ошибка.
 *
 * Сами значения сюда возвращаются как есть — токенов среди них нет и быть не
 * может: секрет живёт в зашифрованном хранилище сервера и наружу уходит только
 * маской в `IntegrationStatus.maskedToken`.
 */

/**
 * Порядок карточек на вкладке — тот же, что у сервера: каждая система — своя
 * интеграция (владелец 10.10.2026), сверху то, без чего остальное бессмысленно.
 */
export const INTEGRATION_IDS = INTEGRATION_ORDER;

/**
 * События уведомлений в порядке от частого к редкому.
 *
 * Список ОДИН на Telegram и вебхук намеренно: это одни и те же события панели,
 * и разойтись им было бы не в чем — разное здесь только то, куда они уходят.
 */
export const TELEGRAM_EVENTS: readonly TelegramEvent[] = [
  'runDone',
  'runError',
  'testFailed',
  'permission',
  'question',
  // Порог бюджета контура — одно событие на оба порога (85 % и «дошли до
  // бюджета»): подписываются на «сообщать ли про бюджет», а какой именно порог,
  // сказано в тексте.
  'budget',
];

const NO_SITE: AtlassianSiteSettings = { enabled: false, baseUrl: '', email: '', deployment: '' };
const NO_FORGE: ForgeSiteSettings = { enabled: false, baseUrl: '', repo: '' };
const NO_TMS: TmsSystemSettings = { enabled: false, baseUrl: '', projectKey: '', groupId: '' };

export const DEFAULT_INTEGRATIONS: IntegrationsSettings = {
  jira: NO_SITE,
  confluence: NO_SITE,
  gitlab: NO_FORGE,
  github: NO_FORGE,
  telegram: { enabled: false, chatId: '', events: [] },
  zephyr: NO_TMS,
  xray: NO_TMS,
  testit: NO_TMS,
  ci: { enabled: false, kind: '', repo: '', workflow: '', artifact: '' },
  webhook: { enabled: false, url: '', events: [] },
};

/**
 * Секция читается как ЧАСТИЧНАЯ, хотя в схеме сервера она полная: настройки —
 * один файл на диске, записанный любой прошлой версией панели, и связка «Jira
 * есть, Confluence нет» — обычное состояние на середине настройки.
 */
type PartialIntegrations = {
  [K in IntegrationId]?: Partial<IntegrationsSettings[K]>;
};

const asText = (value: unknown): string => (typeof value === 'string' ? value : '');
const asFlag = (value: unknown): boolean => value === true;

/** Значение из закрытого списка: чужое — как будто не задано. */
function asOneOf<T extends string>(value: unknown, allowed: readonly T[]): T | '' {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value)
    ? (value as T)
    : '';
}

function readTelegramEvents(value: unknown): TelegramEvent[] {
  if (!Array.isArray(value)) return [];
  return TELEGRAM_EVENTS.filter((event) => value.includes(event));
}

function readSite(raw: Partial<AtlassianSiteSettings> = {}): AtlassianSiteSettings {
  return {
    enabled: asFlag(raw.enabled),
    baseUrl: asText(raw.baseUrl),
    email: asText(raw.email),
    deployment: asOneOf(raw.deployment, ['cloud', 'server'] as const),
  };
}

function readForge(raw: Partial<ForgeSiteSettings> = {}): ForgeSiteSettings {
  return { enabled: asFlag(raw.enabled), baseUrl: asText(raw.baseUrl), repo: asText(raw.repo) };
}

function readTms(raw: Partial<TmsSystemSettings> = {}): TmsSystemSettings {
  return {
    enabled: asFlag(raw.enabled),
    baseUrl: asText(raw.baseUrl),
    projectKey: asText(raw.projectKey),
    groupId: asText(raw.groupId),
  };
}

/** Настройки всех коннекторов с умолчаниями вместо дыр. */
export function readIntegrations(settings: AppSettings | undefined): IntegrationsSettings {
  const raw: PartialIntegrations = settings?.integrations ?? {};
  const telegram: PartialIntegrations['telegram'] = raw.telegram ?? {};
  const ci: PartialIntegrations['ci'] = raw.ci ?? {};
  const webhook: PartialIntegrations['webhook'] = raw.webhook ?? {};

  return {
    jira: readSite(raw.jira),
    confluence: readSite(raw.confluence),
    gitlab: readForge(raw.gitlab),
    github: readForge(raw.github),
    telegram: {
      enabled: asFlag(telegram.enabled),
      chatId: asText(telegram.chatId),
      events: readTelegramEvents(telegram.events),
    },
    zephyr: readTms(raw.zephyr),
    xray: readTms(raw.xray),
    testit: readTms(raw.testit),
    ci: {
      enabled: asFlag(ci.enabled),
      kind: asOneOf(ci.kind, ['github', 'gitlab'] as const),
      repo: asText(ci.repo),
      workflow: asText(ci.workflow),
      artifact: asText(ci.artifact),
    },
    webhook: {
      enabled: asFlag(webhook.enabled),
      url: asText(webhook.url),
      events: readTelegramEvents(webhook.events),
    },
  };
}
