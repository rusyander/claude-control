import type { ForgeSettings } from '@agentdeck/contracts';
import { gitSync } from '../project-git/exec.ts';
import { invalidField, unreachable } from './errors.ts';
import { failedResponse, parseJson, sendRequest } from './http.ts';

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
    throw invalidField(
      'kind',
      'не выбран вид форджа (github или gitlab)',
      'request-forge-kind-missing',
      { field: 'kind' },
    );
  }

  const repo = settings.repo.trim() || (projectRoot ? repoFromOrigin(projectRoot) : '');
  if (!repo) {
    throw invalidField(
      'repo',
      'не указан репозиторий и его не удалось вывести из origin',
      'request-repo-missing',
      { field: 'repo' },
    );
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
    throw invalidField(
      'kind',
      'не выбран вид форджа (github или gitlab)',
      'request-forge-kind-missing',
      { field: 'kind' },
    );
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
    throw failedResponse(systemName(access), response, 500);
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
  if (!title.trim())
    throw invalidField('title', 'не указан заголовок', 'request-title-missing', { field: 'title' });

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

/** Судьба заведённого issue: открыт он ещё или уже закрыт. */
export interface ForgeIssueState {
  /** `open` | `closed`; у GitLab `opened`/`closed` приводится к тому же. */
  state: 'open' | 'closed';
  title?: string;
  url?: string;
}

/**
 * Прочитать issue. Нужен ровно для одного: узнать, закрыт ли заведённый по
 * провалу дефект, — иначе кейс остаётся красным и после починки, до следующего
 * полного прогона.
 */
export async function readForgeIssue(
  access: ForgeAccess,
  issueNumber: number,
): Promise<ForgeIssueState> {
  const path =
    access.kind === 'github'
      ? `/repos/${projectRef(access)}/issues/${issueNumber}`
      : `/projects/${projectRef(access)}/issues/${issueNumber}`;
  const response = await sendRequest({
    url: `${access.api}${path}`,
    system: systemName(access),
    headers: { ...headers(access), Accept: 'application/json' },
  });
  if (!response.ok) {
    throw failedResponse(systemName(access), response, 300);
  }
  const issue = parseJson<{
    state?: string;
    title?: string;
    html_url?: string;
    web_url?: string;
  }>(systemName(access), response);
  return {
    // GitHub отвечает `open`/`closed`, GitLab — `opened`/`closed`/`locked`.
    // Всё, что не закрыто, для панели открыто: промежуточных состояний у
    // вопроса «чинить ли кейс» не бывает.
    state: issue.state === 'closed' ? 'closed' : 'open',
    title: issue.title,
    url: issue.html_url ?? issue.web_url,
  };
}

/** Комментарий к задаче. */
export async function commentForgeIssue(
  access: ForgeAccess,
  issueNumber: number,
  body: string,
): Promise<void> {
  if (!body.trim())
    throw invalidField('body', 'пустой комментарий', 'request-comment-empty', { field: 'body' });
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
  if (!body.trim())
    throw invalidField('body', 'пустой комментарий', 'request-comment-empty', { field: 'body' });
  const path =
    access.kind === 'github'
      ? `/repos/${projectRef(access)}/issues/${mergeRequestNumber}/comments`
      : `/projects/${projectRef(access)}/merge_requests/${mergeRequestNumber}/notes`;
  await post<unknown>(access, path, { body });
}

/** Запрос на слияние, разобранный из ссылки: где он и под каким номером. */
export interface MergeRequestRef {
  kind: ForgeKind;
  /** Корень сайта — из самой ссылки, а не из настройки. */
  site: string;
  /** `owner/repo` у GitHub, полный путь проекта у GitLab (с подгруппами). */
  repo: string;
  /** Номер (`iid` у GitLab, номер PR у GitHub). */
  number: number;
}

/**
 * Разобрать ссылку на MR/PR (Т7). Ссылку даёт человек словами в чате, и она
 * бывает какой угодно: с `/diffs`, с якорем, со своей инсталляции, из группы с
 * подгруппами. Отсюда берётся ВСЁ, кроме токена: вид форджа, сайт, путь проекта
 * и номер — а не из настройки, потому что ревьюят и чужие репозитории.
 *
 * `undefined` — не ссылка на запрос на слияние. Гадать здесь нельзя: панель по
 * этому ответу заводит копию на чужой ветке и пишет комментарий в чужой MR.
 */
export function parseMergeRequestUrl(url: string): MergeRequestRef | undefined {
  let parsed: URL;
  try {
    parsed = new URL(url.trim());
  } catch {
    return undefined;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return undefined;

  const site = `${parsed.protocol}//${parsed.host}`;
  const parts = parsed.pathname.split('/').filter(Boolean).map(decodeURIComponent);

  // GitLab: путь проекта, разделитель `-`, `merge_requests`, номер. Подгруппы
  // дают сколько угодно сегментов до разделителя — поэтому ищем разделитель, а
  // не считаем сегменты с начала.
  const dash = parts.indexOf('-');
  if (dash > 0 && parts[dash + 1] === 'merge_requests') {
    const number = Number(parts[dash + 2]);
    if (!Number.isInteger(number) || number <= 0) return undefined;
    return { kind: 'gitlab', site, repo: parts.slice(0, dash).join('/'), number };
  }
  // GitLab без разделителя `-` — старые ссылки: `<group>/<project>/merge_requests/42`.
  const plain = parts.indexOf('merge_requests');
  if (plain > 0) {
    const number = Number(parts[plain + 1]);
    if (!Number.isInteger(number) || number <= 0) return undefined;
    return { kind: 'gitlab', site, repo: parts.slice(0, plain).join('/'), number };
  }

  // GitHub: `<owner>/<repo>/pull/42`. `pulls` в адресе браузера не бывает, но
  // ссылку иногда копируют из API — принимаем обе формы.
  const pull = parts.findIndex((part) => part === 'pull' || part === 'pulls');
  if (pull === 2) {
    const number = Number(parts[pull + 1]);
    if (!Number.isInteger(number) || number <= 0) return undefined;
    return { kind: 'github', site, repo: parts.slice(0, pull).join('/'), number };
  }

  return undefined;
}

/**
 * Доступ к форджу ПО ССЫЛКЕ: сайт и проект из неё, токен — из интеграции.
 *
 * Именно так, а не из настройки целиком: ревью приходит на MR соседней команды,
 * и репозиторий из настройки (он там ради дефектов) увёл бы запрос не туда.
 * Токен же один на инсталляцию — если он от другого хоста, фордж ответит 401, и
 * это честнее молчаливой подмены проекта.
 */
export function forgeAccessForUrl(url: string, token: string): ForgeAccess | undefined {
  const ref = parseMergeRequestUrl(url);
  if (!ref) return undefined;
  return {
    kind: ref.kind,
    api: apiRoot(ref.kind, ref.site),
    site: ref.site,
    repo: ref.repo,
    token,
  };
}

/** Запрос на слияние глазами панели: откуда ветка копии и чем назвать группу. */
export interface ForgeMergeRequest {
  /** Ветка-источник: от неё панель заводит копию для ревью. */
  branch: string;
  /** Куда он вливается — на случай, если ветку-источник дал сам агент. */
  targetBranch?: string;
  title: string;
  url: string;
  state: 'open' | 'closed';
}

/**
 * Прочитать MR — ради ветки-источника прежде всего (Т7).
 *
 * Ветку панель спрашивает у форджа, а не берёт из блока агента, потому что
 * ошибка здесь тихая: копия заведётся от похожей ветки, ревью прочитает чужой
 * дифф и напишет уверенные замечания не про тот код.
 */
export async function readMergeRequest(
  access: ForgeAccess,
  mergeRequestNumber: number,
): Promise<ForgeMergeRequest> {
  const path =
    access.kind === 'github'
      ? `/repos/${projectRef(access)}/pulls/${mergeRequestNumber}`
      : `/projects/${projectRef(access)}/merge_requests/${mergeRequestNumber}`;
  const response = await sendRequest({
    url: `${access.api}${path}`,
    system: systemName(access),
    headers: { ...headers(access), Accept: 'application/json' },
  });
  if (!response.ok) {
    throw failedResponse(systemName(access), response, 300);
  }
  const mr = parseJson<{
    title?: string;
    state?: string;
    html_url?: string;
    web_url?: string;
    source_branch?: string;
    target_branch?: string;
    head?: { ref?: string };
    base?: { ref?: string };
  }>(systemName(access), response);

  const branch = mr.source_branch ?? mr.head?.ref ?? '';
  if (!branch) {
    throw unreachable(
      `${systemName(access)} не назвал ветку запроса на слияние №${mergeRequestNumber}`,
    );
  }
  const target = mr.target_branch ?? mr.base?.ref;
  return {
    branch,
    ...(target ? { targetBranch: target } : {}),
    title: mr.title ?? `№${mergeRequestNumber}`,
    url:
      mr.html_url ??
      mr.web_url ??
      `${access.site}/${access.repo}/-/merge_requests/${mergeRequestNumber}`,
    // У GitHub `open`/`closed`, у GitLab `opened`/`merged`/`closed`/`locked`.
    // Панели важно одно: ревьюить закрытый MR смысла нет.
    state: mr.state === 'opened' || mr.state === 'open' ? 'open' : 'closed',
  };
}

/**
 * Прочитать MR прямо по ссылке — то, чем пользуется разделение (Т7).
 *
 * `undefined` — ссылка не про запрос на слияние; ошибка сети или отказ форджа
 * бросаются, потому что это разные вещи: первое значит «ревьюить по ссылке
 * нельзя», второе — «сейчас не получилось».
 */
export async function readMergeRequestByUrl(
  url: string,
  token: string,
): Promise<ForgeMergeRequest | undefined> {
  const ref = parseMergeRequestUrl(url);
  const access = forgeAccessForUrl(url, token);
  if (!ref || !access) return undefined;
  return readMergeRequest(access, ref.number);
}

/** Сводный комментарий в MR по его ссылке — вторая половина того же пути. */
export async function commentMergeRequestByUrl(
  url: string,
  token: string,
  body: string,
): Promise<void> {
  const ref = parseMergeRequestUrl(url);
  const access = forgeAccessForUrl(url, token);
  if (!ref || !access) {
    throw invalidField(
      'url',
      'ссылка не похожа на запрос на слияние',
      'request-url-not-merge-request',
      { field: 'url' },
    );
  }
  await commentMergeRequest(access, ref.number, body);
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
    throw failedResponse(systemName(access), response, 500);
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
