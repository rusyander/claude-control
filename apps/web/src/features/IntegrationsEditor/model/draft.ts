import type { IntegrationId, IntegrationsSettings, TelegramEvent } from '@agentdeck/contracts';

/**
 * Черновик карточки коннектора: описание полей, сборка формы и то, что уходит
 * на сервер.
 *
 * Поля описаны данными, а не пятью разными формами: карточки отличаются только
 * набором строк и парой выпадающих списков, и пять почти одинаковых компонентов
 * разошлись бы молча — в одном появилась бы подсказка, в другом нет.
 *
 * Секрета в черновике нет: токен живёт в собственном поле карточки и уходит
 * отдельно от настроек. Пустая строка токена означает «не трогать», а забыть
 * его можно только явной кнопкой — иначе сохранение адреса стирало бы ключ.
 */

export type IntegrationFieldKind = 'text' | 'select';

export interface IntegrationField {
  /** Ключ в настройках коннектора и часть ключа словаря подписи. */
  key: string;
  kind: IntegrationFieldKind;
  /** Значения выпадающего списка; пустая строка = «не выбрано». */
  options?: readonly string[];
  /** Без него включать коннектор бессмысленно. */
  isRequired?: boolean;
  /**
   * Обязательно только при таком значении другого поля.
   *
   * Существует из-за адреса тест-менеджмента: своей установке (Test IT) он
   * необходим, а у Zephyr и Xray API общий на всех и поля нет вовсе. Без этого
   * пришлось бы выбирать между «нельзя включить Zephyr» и «Test IT включается
   * без адреса и падает на первой же кнопке».
   */
  requiredWhen?: { key: string; equals: readonly string[] };
}

/** Поля каждого коннектора в том порядке, в каком их заполняют. */
export const INTEGRATION_FIELDS: Record<IntegrationId, readonly IntegrationField[]> = {
  atlassian: [
    { key: 'baseUrl', kind: 'text', isRequired: true },
    { key: 'email', kind: 'text' },
    { key: 'deployment', kind: 'select', options: ['', 'cloud', 'server'] },
    { key: 'confluenceUrl', kind: 'text' },
  ],
  forge: [
    { key: 'kind', kind: 'select', options: ['', 'github', 'gitlab'], isRequired: true },
    { key: 'baseUrl', kind: 'text' },
    { key: 'repo', kind: 'text' },
  ],
  telegram: [{ key: 'chatId', kind: 'text', isRequired: true }],
  webhook: [{ key: 'url', kind: 'text', isRequired: true }],
  tms: [
    { key: 'kind', kind: 'select', options: ['', 'zephyr', 'xray', 'testit'], isRequired: true },
    { key: 'baseUrl', kind: 'text', requiredWhen: { key: 'kind', equals: ['testit'] } },
    { key: 'projectKey', kind: 'text', isRequired: true },
    { key: 'groupId', kind: 'text' },
  ],
  ci: [
    { key: 'kind', kind: 'select', options: ['', 'github', 'gitlab'], isRequired: true },
    { key: 'repo', kind: 'text' },
    { key: 'workflow', kind: 'text' },
    { key: 'artifact', kind: 'text' },
  ],
};

export type IntegrationDraft = Record<string, string>;

/** Форма из сохранённых настроек: все поля коннектора строками. */
export function draftFrom<T extends IntegrationId>(
  id: T,
  settings: IntegrationsSettings[T],
): IntegrationDraft {
  const source = settings as unknown as Record<string, unknown>;
  const draft: IntegrationDraft = {};
  for (const field of INTEGRATION_FIELDS[id]) {
    const value = source[field.key];
    draft[field.key] = typeof value === 'string' ? value : '';
  }
  return draft;
}

/** Обязательно ли поле при том, что сейчас в форме. */
function isRequiredNow(field: IntegrationField, draft: IntegrationDraft): boolean {
  if (field.isRequired) return true;
  const rule = field.requiredWhen;
  return rule ? rule.equals.includes((draft[rule.key] ?? '').trim()) : false;
}

/** Незаполненные обязательные поля. Пусто — коннектор можно включать. */
export function missingFields(id: IntegrationId, draft: IntegrationDraft): string[] {
  return INTEGRATION_FIELDS[id]
    .filter((field) => isRequiredNow(field, draft) && !(draft[field.key] ?? '').trim())
    .map((field) => field.key);
}

export interface BuildSettingsInput {
  id: IntegrationId;
  draft: IntegrationDraft;
  enabled: boolean;
  /** У Telegram и вебхука: о чём писать. У остальных не читается. */
  events?: TelegramEvent[];
}

/**
 * Тело запроса на сохранение. Значения обрезаются по краям: адрес, скопированный
 * из браузера, почти всегда приезжает с пробелом, а сравнить его с сохранённым
 * потом уже нечем.
 */
export function buildSettings({
  id,
  draft,
  enabled,
  events,
}: BuildSettingsInput): Record<string, unknown> {
  const result: Record<string, unknown> = { enabled };
  for (const field of INTEGRATION_FIELDS[id]) {
    result[field.key] = (draft[field.key] ?? '').trim();
  }
  if (id === 'telegram' || id === 'webhook') result.events = events ?? [];
  return result;
}

/** Отличается ли форма от сохранённого — по нему гаснет кнопка «Сохранить». */
export function isDraftDirty(
  id: IntegrationId,
  draft: IntegrationDraft,
  settings: IntegrationsSettings[IntegrationId],
): boolean {
  const saved = draftFrom(id, settings as never);
  return INTEGRATION_FIELDS[id].some(
    (field) => (draft[field.key] ?? '').trim() !== (saved[field.key] ?? '').trim(),
  );
}

/** Переключение одного события подписки с сохранением известного порядка. */
export function toggleEvent(
  events: readonly TelegramEvent[],
  all: readonly TelegramEvent[],
  event: TelegramEvent,
): TelegramEvent[] {
  const next = events.includes(event)
    ? events.filter((item) => item !== event)
    : [...events, event];
  return all.filter((item) => next.includes(item));
}
