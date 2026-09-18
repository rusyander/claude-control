import type { IntegrationId, IntegrationStatus, IntegrationsSettings } from '@agentdeck/contracts';
import type { AppStore } from '../../lib/app-store.ts';
import {
  clearStoredKey,
  getStoredKey,
  maskKey,
  setStoredKey,
  MAX_KEY_LENGTH,
} from '../../lib/provider-keys.ts';
import { IntegrationError, invalidField } from './errors.ts';
import { readHealth } from './health.ts';
import { coded } from '../../lib/server-text.ts';

/**
 * Одна учётная запись на внешнюю систему: видимая настройка — в состоянии
 * панели, ТОКЕН — в зашифрованном хранилище.
 *
 * Хранилище то же самое, что у ключей провайдеров (`lib/provider-keys.ts`:
 * AES-256-GCM, машинно-локальный ключевой файл, атомарная запись, fail-closed
 * чтение). Второго хранилища секретов в панели нет и заводить его незачем —
 * достаточно другого пространства идентификаторов.
 *
 * ПРЕФИКС `int:` разделяет два пространства в одном файле: `int:atlassian` не
 * может столкнуться с ключом провайдера `anthropic`, а увидев файл, сразу видно,
 * где чей секрет. Наружу токен уходит ТОЛЬКО маской (`abc…4f21`) — ни один путь
 * этого модуля не возвращает значение целиком.
 */

/** Все — всегда, даже неподключённые: страница настроек рисует карточку на каждую. */
export const INTEGRATION_IDS: readonly IntegrationId[] = [
  'atlassian',
  'forge',
  'telegram',
  'tms',
  'ci',
  'webhook',
];

/**
 * Интеграции, живущие БЕЗ токена. У вебхука секрет подписи необязателен: адрес
 * во внутренней сети — законная настройка, и требовать ключ там, где приёмник
 * его не проверяет, значило бы запретить самый частый случай.
 */
const TOKENLESS: readonly IntegrationId[] = ['webhook'];

export function needsToken(id: IntegrationId): boolean {
  return !TOKENLESS.includes(id);
}

/** Ключ токена в общем хранилище секретов панели. */
export function tokenId(id: IntegrationId): string {
  return `int:${id}`;
}

/**
 * ВТОРОЙ ключ Atlassian — личный токен Confluence.
 *
 * На своей установке (Server/DC) Jira и Confluence выдают personal access token
 * каждая отдельно: ключ Jira второй системой отклоняется с 401 на полностью
 * рабочем доступе, и снаружи это выглядит как «Confluence не подключён», хотя
 * подключено всё. У облака токен один на сайт, поэтому ключ НЕОБЯЗАТЕЛЕН: при
 * пустом значении работает основной, и настройки, собранные до появления этого
 * поля, ведут себя ровно как прежде.
 */
export const CONFLUENCE_TOKEN_ID = 'int:atlassian-confluence';

/** Отдельный токен Confluence; пусто = его нет и в ход идёт основной. */
export function readConfluenceToken(appDataDir: string): string | undefined {
  return getStoredKey(appDataDir, CONFLUENCE_TOKEN_ID);
}

/** Сохранить второй ключ; пустая строка стирает его — как и у основного. */
export function writeConfluenceToken(appDataDir: string, token: string): void {
  if (token.length > MAX_KEY_LENGTH) {
    throw invalidField('confluenceToken', 'токен длиннее допустимого', 'request-token-too-long', {
      field: 'confluenceToken',
    });
  }
  setStoredKey(appDataDir, CONFLUENCE_TOKEN_ID, token);
}

export function isIntegrationId(value: string): value is IntegrationId {
  return (INTEGRATION_IDS as readonly string[]).includes(value);
}

/** Настройки всех интеграций из состояния панели. */
export function readIntegrations(store: AppStore): IntegrationsSettings {
  return store.getSettings().integrations;
}

/** Токен интеграции — только для исходящего запроса, наружу он не отдаётся. */
export function readToken(appDataDir: string, id: IntegrationId): string | undefined {
  return getStoredKey(appDataDir, tokenId(id));
}

/**
 * Сохранить токен. Пустая строка стирает сохранённый — это осознанная операция
 * («выкинуть ключ»), а не пустое сохранение формы, поэтому маршрут присылает
 * поле только тогда, когда человек его тронул.
 */
export function writeToken(appDataDir: string, id: IntegrationId, token: string): void {
  if (token.length > MAX_KEY_LENGTH) {
    throw invalidField('token', 'токен длиннее допустимого', 'request-token-too-long', {
      field: 'token',
    });
  }
  setStoredKey(appDataDir, tokenId(id), token);
}

export function forgetToken(appDataDir: string, id: IntegrationId): void {
  clearStoredKey(appDataDir, tokenId(id));
}

/**
 * Записать видимую настройку одной интеграции. Пишем ЦЕЛИКОМ по своему ключу:
 * карточка присылает свою настройку одним объектом, а соседние карточки в этом
 * же PATCH не участвуют и обязаны остаться нетронутыми.
 */
export function writeSettings<K extends IntegrationId>(
  store: AppStore,
  id: K,
  settings: IntegrationsSettings[K],
): IntegrationsSettings {
  const current = readIntegrations(store);
  const next: IntegrationsSettings = { ...current, [id]: settings };
  store.updateSettings({ integrations: next });
  return next;
}

/**
 * Что панель показывает про интеграцию: включена ли, есть ли токен (маской) и
 * чем кончилась последняя живая проверка.
 *
 * Токен НЕ читается ради самого значения — только чтобы посчитать маску и
 * ответить «да, ключ сохранён». Значение не покидает эту функцию.
 */
export function describeIntegration(
  store: AppStore,
  appDataDir: string,
  id: IntegrationId,
): IntegrationStatus {
  const settings = readIntegrations(store)[id];
  const token = readToken(appDataDir, id) ?? '';
  const health = readHealth(store, id);
  // Второй ключ есть только у Atlassian: у остальных карточек поля нет вовсе, и
  // признак «ключа нет» на них читался бы как «ключ забыли ввести».
  const confluence = id === 'atlassian' ? (readConfluenceToken(appDataDir) ?? '') : '';

  return {
    id,
    enabled: settings.enabled,
    hasToken: Boolean(token),
    maskedToken: token ? maskKey(token) : '',
    state: health?.state ?? 'unchecked',
    detail: health?.detail ?? '',
    checkedAt: health?.checkedAt,
    account: health?.account,
    deployment: health?.deployment,
    ...(id === 'atlassian'
      ? {
          hasConfluenceToken: Boolean(confluence),
          maskedConfluenceToken: confluence ? maskKey(confluence) : '',
        }
      : {}),
  };
}

/** Все карточки — то, чем отвечает `GET /api/integrations`. */
export function describeIntegrations(store: AppStore, appDataDir: string): IntegrationStatus[] {
  return INTEGRATION_IDS.map((id) => describeIntegration(store, appDataDir, id));
}

/**
 * Забыть интеграцию: токен стирается, карточка гасится, след проверки уходит.
 * Видимую настройку (адрес, почту, ключ проекта) НЕ трогаем — человек снимает
 * ключ, а не переезжает на другой сайт, и заново вводить адрес его незачем.
 */
export function forgetIntegration(
  store: AppStore,
  appDataDir: string,
  id: IntegrationId,
): IntegrationStatus {
  forgetToken(appDataDir, id);
  // «Забыть» относится ко всему доступу карточки: оставленный второй ключ
  // Confluence был бы секретом без единого следа в панели.
  if (id === 'atlassian') clearStoredKey(appDataDir, CONFLUENCE_TOKEN_ID);
  store.forgetIntegrationHealth(tokenId(id));
  const settings = readIntegrations(store)[id];
  writeSettings(store, id, { ...settings, enabled: false });
  return describeIntegration(store, appDataDir, id);
}

/** Интеграция включена и токен есть — иначе честный отказ с именем системы. */
export function requireConnected(
  store: AppStore,
  appDataDir: string,
  id: IntegrationId,
  title: string,
): string {
  const settings = readIntegrations(store)[id];
  const token = readToken(appDataDir, id);
  if (!settings.enabled || (needsToken(id) && !token)) {
    throw coded(
      new IntegrationError(
        'integration_not_found',
        `${title} не подключена: включите её и сохраните токен в настройках панели.`,
      ),
      'integration-not-connected',
      { title },
    );
  }
  return token ?? '';
}
