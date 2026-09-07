import type { ForgeSettings } from '@agentdeck/contracts';
import { gitSync } from '../project-git/exec.ts';
import { invalidField, unreachable } from './errors.ts';
import { describeFailure, parseJson, sendRequest } from './http.ts';

/**
 * Фордж по ТОКЕНУ: дефекты и комментарии без установленных `gh`/`glab`.
 *
 * Зачем, если CLI уже умеет то же самое: `gh` и `glab` есть далеко не везде —
 * на рабочей машине с закрытым интернетом, на чужом ноутбуке, на своей
 * инсталляции GitLab за прокси. Токен же есть у каждого, кто вообще работает с
 * форджем. CLI остаётся запасным путём и НЕ убирается: он не требует от панели
 * хранить чужой секрет, и там, где он есть, он и лучше.
 *
 * Репозиторий берётся из настройки, а не угадывается всегда: `owner/repo` из
 * origin верен, пока origin один и указывает туда, куда человек думает. Но
 * пустая настройка — не повод сдаться, поэтому origin читается как подсказка.
 */

export type ForgeKind = 'github' | 'gitlab';

/**
 * Чего достаточно, чтобы спросить «кто я»: вид форджа, корень API и токен.
 *
 * Отдельно от полного доступа, потому что проверка связи не должна требовать
 * репозитория: человек сохраняет ключ раньше, чем выбирает проект, и отказ
 * «не указан репозиторий» на кнопке «Проверить связь» отправил бы его чинить
 * не то.
 */
export interface ForgeIdentity {
  kind: ForgeKind;
  /** Корень API: `https://api.github.com` или `https://gitlab.com/api/v4`. */
  api: string;
  token: string;
}

export interface ForgeAccess extends ForgeIdentity {
  /** Корень сайта — для ссылок, которые API не вернул. */
  site: string;
  repo: string;
}

const GITHUB_CLOUD = 'https://github.com';
const GITLAB_CLOUD = 'https://gitlab.com';

function trim(url: string): string {
  return url.trim().replace(/\/+$/, '');
}

/**
 * Собрать доступ. `projectRoot` нужен ровно для одного: вывести `owner/repo` из
 * origin, когда настройка пуста.
 */
export function toForgeAccess(
  settings: ForgeSettings,
  token: string,
  projectRoot?: string,
): ForgeAccess {
  const kind = settings.kind;
  if (kind !== 'github' && kind !== 'gitlab') {
    throw invalidField('kind', 'не выбран вид форджа (github или gitlab)');
  }

  const repo = settings.repo.trim() || (projectRoot ? repoFromOrigin(projectRoot) : '');
  if (!repo) {
    throw invalidField('repo', 'не указан репозиторий и его не удалось вывести из origin');
  }

  const site = trim(settings.baseUrl) || (kind === 'github' ? GITHUB_CLOUD : GITLAB_CLOUD);
  return { kind, api: apiRoot(kind, site), site, repo, token };
}

/**
 * Корень API. У github.com он живёт на отдельном хосте, у GitHub Enterprise —
 * на своём под `/api/v3`; у GitLab он всегда `/api/v4` того же сайта.
 */
function apiRoot(kind: ForgeKind, site: string): string {
  if (kind === 'gitlab') return `${site}/api/v4`;
  return site === GITHUB_CLOUD ? 'https://api.github.com' : `${site}/api/v3`;
}

/**
 * Доступ без репозитория — для проверки связи. Адрес инсталляции учитывается:
 * у своего GitHub Enterprise и своего GitLab корень API другой.
 */
export function toForgeIdentity(settings: ForgeSettings, token: string): ForgeIdentity {
  const kind = settings.kind;
  if (kind !== 'github' && kind !== 'gitlab') {
    throw invalidField('kind', 'не выбран вид форджа (github или gitlab)');
  }
  const site = trim(settings.baseUrl) || (kind === 'github' ? GITHUB_CLOUD : GITLAB_CLOUD);
  return { kind, api: apiRoot(kind, site), token };
}

/** Заголовки: у GitHub Bearer, у GitLab свой `PRIVATE-TOKEN`. */
function headers(access: ForgeIdentity): Record<string, string> {
  return access.kind === 'github'
    ? {
        Authorization: `Bearer ${access.token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
      }
    : { 'PRIVATE-TOKEN': access.token };
}

function systemName(access: ForgeIdentity): string {
  return access.kind === 'github' ? 'GitHub' : 'GitLab';
}

/** Путь проекта в адресе GitLab кодируется целиком, вместе со слэшами. */
function projectRef(access: ForgeAccess): string {
  return access.kind === 'github' ? access.repo : encodeURIComponent(access.repo);
}

async function post<T>(access: ForgeAccess, path: string, body: unknown): Promise<T> {
  const response = await sendRequest({
    url: `${access.api}${path}`,
    method: 'POST',
    system: systemName(access),
    headers: { ...headers(access), 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    throw unreachable(describeFailure(systemName(access), response), response.text.slice(0, 500));
  }
  return parseJson<T>(systemName(access), response);
}

export interface ForgeIssue {
  url: string;
  /** Номер задачи: у GitHub `number`, у GitLab `iid`. */
  number: number;
}

/** Завести задачу. Возвращает ссылку — её панель пишет обратно в кейс. */
export async function createForgeIssue(
  access: ForgeAccess,
  title: string,
  body: string,
): Promise<ForgeIssue> {
  if (!title.trim()) throw invalidField('title', 'не указан заголовок');

  if (access.kind === 'github') {
    const created = await post<{ html_url?: string; number?: number }>(
      access,
      `/repos/${projectRef(access)}/issues`,
      { title, body },
    );
    return {
      url: created.html_url ?? `${access.site}/${access.repo}/issues/${created.number ?? ''}`,
      number: created.number ?? 0,
    };
  }

  const created = await post<{ web_url?: string; iid?: number }>(
    access,
    `/projects/${projectRef(access)}/issues`,
    { title, description: body },
  );
  return {
    url: created.web_url ?? `${access.site}/${access.repo}/-/issues/${created.iid ?? ''}`,
    number: created.iid ?? 0,
  };
}

/** Комментарий к задаче. */
export async function commentForgeIssue(
  access: ForgeAccess,
  issueNumber: number,
  body: string,
): Promise<void> {
  if (!body.trim()) throw invalidField('body', 'пустой комментарий');
  const path =
    access.kind === 'github'
      ? `/repos/${projectRef(access)}/issues/${issueNumber}/comments`
      : `/projects/${projectRef(access)}/issues/${issueNumber}/notes`;
  await post<unknown>(access, path, { body });
}

/**
 * Связать запрос на слияние с прогоном: комментарий со ссылкой на отчёт.
 *
 * Именно комментарий, а не поле: панель не правит описание чужого MR — это
 * текст автора, и дописывать в него от чужого имени нельзя.
 */
export async function commentMergeRequest(
  access: ForgeAccess,
  mergeRequestNumber: number,
  body: string,
): Promise<void> {
  if (!body.trim()) throw invalidField('body', 'пустой комментарий');
  const path =
    access.kind === 'github'
      ? `/repos/${projectRef(access)}/issues/${mergeRequestNumber}/comments`
      : `/projects/${projectRef(access)}/merge_requests/${mergeRequestNumber}/notes`;
  await post<unknown>(access, path, { body });
}

/** Кто мы для форджа — то же «представились», что и у Atlassian. */
export async function whoAmI(access: ForgeIdentity): Promise<string> {
  // Ручка называется одинаково у обоих: `/user` отдаёт владельца токена.
  const response = await sendRequest({
    url: `${access.api}/user`,
    system: systemName(access),
    headers: { ...headers(access), Accept: 'application/json' },
  });
  if (!response.ok) {
    throw unreachable(describeFailure(systemName(access), response), response.text.slice(0, 500));
  }
  const me = parseJson<{ login?: string; username?: string; name?: string }>(
    systemName(access),
    response,
  );
  return me.login || me.username || me.name || 'учётная запись без имени';
}

/**
 * `owner/repo` из адреса origin. Понимает обе формы, ssh и https, с `.git` и
 * без; чужой хост (своя инсталляция GitLab) тоже даёт правильный путь проекта,
 * потому что берётся всё после хоста.
 */
export function repoFromOrigin(projectRoot: string): string {
  const url = gitSync(projectRoot, ['remote', 'get-url', 'origin'])?.trim();
  if (!url) return '';
  const ssh = url.match(/^[^@]+@[^:]+:(.+?)(?:\.git)?$/);
  if (ssh?.[1]) return ssh[1];
  const https = url.match(/^https?:\/\/[^/]+\/(.+?)(?:\.git)?$/);
  return https?.[1] ?? '';
}
