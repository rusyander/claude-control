import type { AtlassianDeployment, AtlassianSiteSettings } from '@agentdeck/contracts';
import { invalidField } from '../errors.ts';
import { failedResponse, parseJson, sendRequest, type OutboundResponse } from '../http/http.ts';

/**
 * Один клиент Atlassian на два диалекта: облако и своя установка (Server/DC).
 *
 * Разница не косметическая, и её нельзя спросить у пользователя галочкой —
 * половина людей не знает ответа, а вторая половина ошибается. Поэтому вид
 * установки ОПРЕДЕЛЯЕТСЯ живой проверкой и запоминается в настройках:
 *
 * - облако: авторизация Basic `почта:токен`, Jira на `/rest/api/3`, Confluence
 *   на `/wiki` (v2 для страниц, CQL-поиск на `/wiki/rest/api`);
 * - Server/DC: авторизация `Bearer токен` (personal access token, почты нет),
 *   Jira на `/rest/api/2`, Confluence на `/rest/api/content` без префикса.
 *
 * Всё остальное — те же ручки и те же поля, поэтому клиент один, а не два.
 *
 * Jira и Confluence — РАЗНЫЕ интеграции со своим адресом и своим ключом
 * (владелец 10.10.2026): на своей установке это разные приложения, и personal
 * access token каждое выдаёт своё — ключ Jira Confluence отклоняет с 401 на
 * полностью рабочем доступе. Поэтому доступ собирается на одну систему, и
 * `baseUrl` у доступа Confluence — уже корень вики (`toConfluenceAccess`).
 */

export interface AtlassianAccess {
  baseUrl: string;
  email: string;
  token: string;
  deployment: AtlassianDeployment;
}

/** Как `system` называет Confluence во всех его запросах. */
export const CONFLUENCE_SYSTEM = 'Confluence';

/** Адрес без хвостового слэша: иначе пути склеиваются с двойным. */
export function trimUrl(url: string): string {
  return url.trim().replace(/\/+$/, '');
}

/**
 * Заголовки авторизации. Облако принимает Basic с почтой и API-токеном; своя
 * установка почты не знает вовсе и ждёт Bearer. Ошибиться диалектом = получить
 * 401 на верном токене, поэтому решает только `deployment`.
 */
export function authHeaders(access: AtlassianAccess): Record<string, string> {
  const token = access.token;
  if (access.deployment === 'cloud') {
    const basic = Buffer.from(`${access.email}:${token}`, 'utf8').toString('base64');
    return { Authorization: `Basic ${basic}` };
  }
  return { Authorization: `Bearer ${token}` };
}

/** Корень Jira REST для этого диалекта. */
export function jiraApi(access: AtlassianAccess): string {
  return `${access.baseUrl}/rest/api/${access.deployment === 'cloud' ? '3' : '2'}`;
}

/**
 * Корень Confluence. Доступ Confluence собран так, что `baseUrl` — уже корень
 * вики (у облака с `/wiki`, см. `toConfluenceAccess`).
 */
export function confluenceRoot(access: AtlassianAccess): string {
  return access.baseUrl;
}

export interface AtlassianCall {
  url: string;
  method?: string;
  body?: unknown;
  /** Как назвать систему в отказе: «Jira» или «Confluence». */
  system: string;
}

/** Запрос к Atlassian: заголовки, JSON-тело, разбор ответа, русский отказ. */
export async function call<T>(access: AtlassianAccess, request: AtlassianCall): Promise<T> {
  const response = await raw(access, request);
  if (!response.ok) throw failedResponse(request.system, response, 500);
  return parseJson<T>(request.system, response);
}

/** То же, но ответ отдаётся как есть: часть проверок читает сам код ответа. */
export async function raw(
  access: AtlassianAccess,
  request: AtlassianCall,
): Promise<OutboundResponse> {
  return sendRequest({
    url: request.url,
    method: request.method ?? 'GET',
    system: request.system,
    headers: {
      ...authHeaders(access),
      Accept: 'application/json',
      ...(request.body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    body: request.body === undefined ? undefined : JSON.stringify(request.body),
  });
}

/** Кто мы для Atlassian: имя учётной записи из ответа `myself`. */
interface MyselfResponse {
  displayName?: string;
  name?: string;
  emailAddress?: string;
}

export interface DeploymentProbe {
  deployment: AtlassianDeployment;
  account: string;
}

/**
 * Живое определение вида установки.
 *
 * Порядок именно такой: сначала облачный диалект (v3 + Basic), потом свой (v2 +
 * Bearer). Облако на v2 тоже отвечает, поэтому обратный порядок определял бы
 * облако как Server и ломал бы Confluence — там пути расходятся по-настоящему.
 *
 * Отказ ОБОИХ диалектов — это не «непонятно что», а внятная причина: сохраняем
 * ту, что вернул первый запрос, иначе человек чинил бы не то.
 */
export async function detectDeployment(
  access: Omit<AtlassianAccess, 'deployment'>,
): Promise<DeploymentProbe> {
  if (!access.baseUrl)
    throw invalidField('baseUrl', 'не указан адрес Atlassian', 'request-atlassian-url-missing', {
      field: 'baseUrl',
    });
  if (!access.token)
    throw invalidField('token', 'не сохранён токен Atlassian', 'request-atlassian-token-missing', {
      field: 'token',
    });

  const cloud: AtlassianAccess = { ...access, deployment: 'cloud' };
  const cloudResponse = access.email
    ? await raw(cloud, { url: `${jiraApi(cloud)}/myself`, system: 'Jira' })
    : undefined;
  if (cloudResponse?.ok) {
    const me = parseJson<MyselfResponse>('Jira', cloudResponse);
    return { deployment: 'cloud', account: accountName(me) };
  }

  const server: AtlassianAccess = { ...access, deployment: 'server' };
  const serverResponse = await raw(server, { url: `${jiraApi(server)}/myself`, system: 'Jira' });
  if (serverResponse.ok) {
    const me = parseJson<MyselfResponse>('Jira', serverResponse);
    return { deployment: 'server', account: accountName(me) };
  }

  // Показываем отказ ОБЛАКА, если почта была задана: человек, вводивший почту,
  // метил в облако, и «токен отклонён» ему понятнее, чем ответ второй попытки.
  const decisive = cloudResponse ?? serverResponse;
  throw failedResponse('Atlassian', decisive, 500);
}

/**
 * То же определение для Confluence, подключённой без Jira: «кто я» спрашивается
 * у самой вики. Облако — Basic с почтой под `/wiki` сайта, своя установка —
 * Bearer в корне её адреса; порядок и выбор причины отказа — как у Jira.
 */
export async function detectConfluenceDeployment(
  access: Omit<AtlassianAccess, 'deployment'>,
): Promise<DeploymentProbe> {
  if (!access.baseUrl)
    throw invalidField('baseUrl', 'не указан адрес Confluence', 'request-atlassian-url-missing', {
      field: 'baseUrl',
    });
  if (!access.token)
    throw invalidField('token', 'не сохранён токен Confluence', 'request-atlassian-token-missing', {
      field: 'token',
    });

  const settings = { baseUrl: access.baseUrl, email: access.email, enabled: true };
  const cloud = toConfluenceAccess({ ...settings, deployment: 'cloud' }, access.token);
  const cloudResponse = access.email
    ? await raw(cloud, {
        url: `${confluenceRoot(cloud)}/rest/api/user/current`,
        system: CONFLUENCE_SYSTEM,
      })
    : undefined;
  if (cloudResponse?.ok) {
    const me = parseJson<MyselfResponse>(CONFLUENCE_SYSTEM, cloudResponse);
    return { deployment: 'cloud', account: accountName(me) };
  }

  const server = toConfluenceAccess({ ...settings, deployment: 'server' }, access.token);
  const serverResponse = await raw(server, {
    url: `${confluenceRoot(server)}/rest/api/user/current`,
    system: CONFLUENCE_SYSTEM,
  });
  if (serverResponse.ok) {
    const me = parseJson<MyselfResponse>(CONFLUENCE_SYSTEM, serverResponse);
    return { deployment: 'server', account: accountName(me) };
  }
  throw failedResponse(CONFLUENCE_SYSTEM, cloudResponse ?? serverResponse, 500);
}

function accountName(me: MyselfResponse): string {
  return me.displayName || me.name || me.emailAddress || 'учётная запись без имени';
}

/**
 * Собрать доступ из настроек и токена. Вид установки берём из настроек, а если
 * он там не записан — считаем облаком при заданной почте и своей установкой без
 * неё: это ровно та подсказка, которую человек уже дал, заполняя форму.
 */
export function toAccess(settings: AtlassianSiteSettings, token: string): AtlassianAccess {
  const baseUrl = trimUrl(settings.baseUrl);
  if (!baseUrl)
    throw invalidField('baseUrl', 'не указан адрес Atlassian', 'request-atlassian-url-missing', {
      field: 'baseUrl',
    });
  return {
    baseUrl,
    email: settings.email.trim(),
    token,
    deployment: settings.deployment || (settings.email.trim() ? 'cloud' : 'server'),
  };
}

/**
 * Доступ Confluence: тот же, но корень — вики. Облако держит её под `/wiki`
 * сайта; человек, вписавший адрес сайта без него, получил бы 404 на верном
 * ключе, поэтому путь достраивается здесь, в одном месте.
 */
export function toConfluenceAccess(
  settings: AtlassianSiteSettings,
  token: string,
): AtlassianAccess {
  const access = toAccess(settings, token);
  if (access.deployment !== 'cloud' || /\/wiki$/.test(access.baseUrl)) return access;
  return { ...access, baseUrl: `${access.baseUrl}/wiki` };
}
