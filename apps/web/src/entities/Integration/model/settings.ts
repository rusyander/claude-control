import type {
  AppSettings,
  IntegrationId,
  IntegrationLink,
  IntegrationsSettings,
  TelegramEvent,
} from '@agentdeck/contracts';

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

/** Порядок карточек на вкладке: сверху то, без чего остальное бессмысленно. */
export const INTEGRATION_IDS = ['atlassian', 'forge', 'telegram', 'webhook', 'tms', 'ci'] as const;

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
];

export const DEFAULT_INTEGRATIONS: IntegrationsSettings = {
  atlassian: { enabled: false, baseUrl: '', email: '', deployment: '', confluenceUrl: '' },
  forge: { enabled: false, kind: '', baseUrl: '', repo: '' },
  telegram: { enabled: false, chatId: '', events: [] },
  tms: { enabled: false, kind: '', projectKey: '', groupId: '' },
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

/** Настройки всех коннекторов с умолчаниями вместо дыр. */
export function readIntegrations(settings: AppSettings | undefined): IntegrationsSettings {
  const raw: PartialIntegrations = settings?.integrations ?? {};
  const atlassian: PartialIntegrations['atlassian'] = raw.atlassian ?? {};
  const forge: PartialIntegrations['forge'] = raw.forge ?? {};
  const telegram: PartialIntegrations['telegram'] = raw.telegram ?? {};
  const tms: PartialIntegrations['tms'] = raw.tms ?? {};
  const ci: PartialIntegrations['ci'] = raw.ci ?? {};
  const webhook: PartialIntegrations['webhook'] = raw.webhook ?? {};

  return {
    atlassian: {
      enabled: asFlag(atlassian.enabled),
      baseUrl: asText(atlassian.baseUrl),
      email: asText(atlassian.email),
      deployment: asOneOf(atlassian.deployment, ['cloud', 'server'] as const),
      confluenceUrl: asText(atlassian.confluenceUrl),
    },
    forge: {
      enabled: asFlag(forge.enabled),
      kind: asOneOf(forge.kind, ['github', 'gitlab'] as const),
      baseUrl: asText(forge.baseUrl),
      repo: asText(forge.repo),
    },
    telegram: {
      enabled: asFlag(telegram.enabled),
      chatId: asText(telegram.chatId),
      events: readTelegramEvents(telegram.events),
    },
    tms: {
      enabled: asFlag(tms.enabled),
      kind: asOneOf(tms.kind, ['zephyr', 'xray'] as const),
      projectKey: asText(tms.projectKey),
      groupId: asText(tms.groupId),
    },
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

/** Настройки одного коннектора — тип выводится из его id, без ручных развилок. */
export function readIntegration<T extends IntegrationId>(
  settings: AppSettings | undefined,
  id: T,
): IntegrationsSettings[T] {
  return readIntegrations(settings)[id];
}

/**
 * Пустая ли привязка. Отсутствующая и «привязка, из которой всё стёрли» — одно
 * и то же состояние для человека, и показывать её строкой не за что.
 */
export function isLinkEmpty(link: IntegrationLink | undefined): boolean {
  if (!link) return true;
  return !(
    link.jiraProjectKey ||
    link.jiraIssueKey ||
    link.confluencePageId ||
    link.forgeRepo ||
    link.note
  );
}
