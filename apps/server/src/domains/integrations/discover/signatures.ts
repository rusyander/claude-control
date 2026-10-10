import type { IntegrationId } from '@agentdeck/contracts';
import type { Launched, VarLookup } from './launch.ts';

/**
 * Как узнать систему в MCP-сервере: по пакету, образу или адресу — и по тем
 * переменным, которые читают известные серверы этой системы.
 *
 * Переменные взяты у самих серверов, а не придуманы: `sooperset/mcp-atlassian`
 * (`JIRA_URL`, `JIRA_USERNAME`, `JIRA_API_TOKEN` / `JIRA_PERSONAL_TOKEN`, то же
 * с `CONFLUENCE_`), `@aashari/mcp-server-atlassian-*` (`ATLASSIAN_SITE_NAME`,
 * `ATLASSIAN_USER_EMAIL`, `ATLASSIAN_API_TOKEN`), `@zereight/mcp-gitlab` и
 * `server-gitlab` (`GITLAB_PERSONAL_ACCESS_TOKEN`, `GITLAB_API_URL`), GitHub
 * (`GITHUB_PERSONAL_ACCESS_TOKEN`, `GITHUB_HOST`; удалённый сервер —
 * заголовком `Authorization`), Telegram (`TELEGRAM_BOT_TOKEN`,
 * `TELEGRAM_CHAT_ID`), адаптеры Test IT (`TMS_URL`, `TMS_PRIVATE_TOKEN`,
 * `TMS_PROJECT_ID`), Xray (`XRAY_CLIENT_ID`, `XRAY_CLIENT_SECRET`).
 */

export interface Recognized {
  id: IntegrationId;
  /** Видимые поля настройки интеграции. */
  fields: Record<string, string>;
  token: string;
  /** Поля, без которых интеграция работать не будет. */
  required: string[];
}

interface Signature {
  id: IntegrationId;
  /** Пакет, образ или адрес этой системы. */
  package: RegExp;
  /** Переменные, одна из которых выдаёт систему и без узнанного пакета. */
  marks: readonly string[];
  read: (get: VarLookup, launched: Launched) => Omit<Recognized, 'id'>;
}

const first = (get: VarLookup, ...names: string[]): string => {
  for (const name of names) {
    const value = get(name)?.trim();
    if (value) return value;
  }
  return '';
};

/** Ключ из заголовка: `Authorization: Bearer x`, `Token x` или `PRIVATE-TOKEN: x`. */
function headerToken(headers: Record<string, string>): string {
  for (const [key, value] of Object.entries(headers)) {
    const lower = key.toLowerCase();
    if (lower === 'private-token') return value.trim();
    if (lower === 'authorization') {
      return value.replace(/^\s*(?:bearer|token)\s+/i, '').trim();
    }
  }
  return '';
}

/** Облачный сайт Atlassian по его имени (`ATLASSIAN_SITE_NAME=acme`). */
const siteUrl = (site: string): string =>
  !site
    ? ''
    : /^https?:\/\//.test(site)
      ? site.replace(/\/+$/, '')
      : `https://${site}.atlassian.net`;

function atlassian(system: 'JIRA' | 'CONFLUENCE', wiki: boolean): Signature['read'] {
  return (get) => {
    const own = first(get, `${system}_PERSONAL_TOKEN`);
    const cloud = first(get, `${system}_API_TOKEN`, 'ATLASSIAN_API_TOKEN');
    const email = first(get, `${system}_USERNAME`, `${system}_EMAIL`, 'ATLASSIAN_USER_EMAIL');
    const site = siteUrl(first(get, 'ATLASSIAN_SITE_NAME'));
    const baseUrl = first(get, `${system}_URL`) || (site && wiki ? `${site}/wiki` : site);
    return {
      fields: {
        baseUrl,
        email: own ? '' : email,
        // Личный токен бывает только у своей установки, пара почта + API-токен —
        // у облака; иначе вид определит первая живая проверка.
        deployment: own ? 'server' : cloud && email ? 'cloud' : '',
      },
      token: own || cloud,
      required: ['baseUrl', 'token'],
    };
  };
}

/** `https://gitlab.acme.ru/api/v4` → `https://gitlab.acme.ru`: интеграция хранит адрес сайта. */
const gitlabSite = (url: string): string =>
  url.replace(/\/api\/v4(?:\/.*)?$/, '').replace(/\/+$/, '');

const SIGNATURES: readonly Signature[] = [
  {
    id: 'jira',
    package: /mcp-atlassian|atlassian-jira|jira|mcp\.atlassian\.com/,
    marks: ['JIRA_URL', 'JIRA_API_TOKEN', 'JIRA_PERSONAL_TOKEN'],
    read: atlassian('JIRA', false),
  },
  {
    id: 'confluence',
    package: /mcp-atlassian|atlassian-confluence|confluence|mcp\.atlassian\.com/,
    marks: ['CONFLUENCE_URL', 'CONFLUENCE_API_TOKEN', 'CONFLUENCE_PERSONAL_TOKEN'],
    read: atlassian('CONFLUENCE', true),
  },
  {
    id: 'gitlab',
    package: /gitlab/,
    marks: ['GITLAB_PERSONAL_ACCESS_TOKEN', 'GITLAB_API_URL'],
    read: (get, launched) => {
      const url = first(get, 'GITLAB_API_URL', 'GITLAB_URL', 'GITLAB_HOST');
      const site = gitlabSite(url ? (/^https?:\/\//.test(url) ? url : `https://${url}`) : '');
      const remote = launched.url ? gitlabSite(launched.url.replace(/\/api\/v4\/mcp.*$/, '')) : '';
      const baseUrl = site || remote;
      return {
        // gitlab.com — облако: у интеграции пустой адрес и значит облако.
        fields: { baseUrl: /^https:\/\/gitlab\.com$/.test(baseUrl) ? '' : baseUrl },
        token:
          first(get, 'GITLAB_PERSONAL_ACCESS_TOKEN', 'GITLAB_TOKEN', 'GITLAB_ACCESS_TOKEN') ||
          headerToken(launched.headers),
        required: ['token'],
      };
    },
  },
  {
    id: 'github',
    package: /github/,
    marks: ['GITHUB_PERSONAL_ACCESS_TOKEN'],
    read: (get, launched) => {
      const host = first(get, 'GITHUB_HOST');
      const site =
        host && !/github\.com$/.test(host)
          ? /^https?:\/\//.test(host)
            ? host
            : `https://${host}`
          : '';
      return {
        fields: { baseUrl: site.replace(/\/+$/, '') },
        token:
          first(get, 'GITHUB_PERSONAL_ACCESS_TOKEN', 'GITHUB_TOKEN') ||
          headerToken(launched.headers),
        required: ['token'],
      };
    },
  },
  {
    id: 'telegram',
    package: /telegram/,
    marks: ['TELEGRAM_BOT_TOKEN'],
    read: (get) => ({
      fields: { chatId: first(get, 'TELEGRAM_CHAT_ID') },
      token: first(get, 'TELEGRAM_BOT_TOKEN'),
      required: ['token', 'chatId'],
    }),
  },
  {
    id: 'zephyr',
    package: /zephyr/,
    marks: ['ZEPHYR_API_TOKEN', 'ZEPHYR_SCALE_API_TOKEN'],
    read: (get) => ({
      fields: { projectKey: first(get, 'ZEPHYR_PROJECT_KEY', 'JIRA_PROJECT_KEY') },
      token: first(get, 'ZEPHYR_API_TOKEN', 'ZEPHYR_SCALE_API_TOKEN', 'ZEPHYR_TOKEN'),
      required: ['token', 'projectKey'],
    }),
  },
  {
    id: 'xray',
    package: /xray/,
    marks: ['XRAY_CLIENT_ID'],
    read: (get) => {
      const id = first(get, 'XRAY_CLIENT_ID');
      const secret = first(get, 'XRAY_CLIENT_SECRET');
      return {
        fields: { projectKey: first(get, 'XRAY_PROJECT_KEY', 'JIRA_PROJECT_KEY') },
        // Клиент Xray панели ждёт пару одним ключом: `id:секрет` (`tms/xray.ts`).
        token: id && secret ? `${id}:${secret}` : '',
        required: ['token', 'projectKey'],
      };
    },
  },
  {
    id: 'testit',
    package: /testit|test-it/,
    marks: ['TMS_PRIVATE_TOKEN', 'TESTIT_PRIVATE_TOKEN'],
    read: (get) => ({
      fields: {
        baseUrl: first(get, 'TMS_URL', 'TESTIT_URL').replace(/\/+$/, ''),
        projectKey: first(get, 'TMS_PROJECT_ID', 'TESTIT_PROJECT_ID'),
      },
      token: first(get, 'TMS_PRIVATE_TOKEN', 'TESTIT_PRIVATE_TOKEN', 'TESTIT_TOKEN'),
      required: ['baseUrl', 'token', 'projectKey'],
    }),
  },
];

/**
 * Что узнаётся в одном сервере. Система засчитывается, когда её выдаёт пакет
 * (тогда сервер получает и унаследованные переменные — так их видит сам
 * сервер) или явная переменная-метка; одно лишь `GITHUB_TOKEN` в окружении
 * машины чужой сервер GitHub-ом не делает.
 */
export function recognize(launched: Launched, inherited: VarLookup): Recognized[] {
  const found: Recognized[] = [];
  for (const signature of SIGNATURES) {
    const byPackage = signature.package.test(launched.haystack);
    const byMark = signature.marks.some((name) => launched.explicit(name));
    if (!byPackage && !byMark) continue;
    const get: VarLookup = (name) =>
      launched.explicit(name) ?? (byPackage ? inherited(name) : undefined);
    const read = signature.read(get, launched);
    // Пакет Atlassian несёт обе системы, но настроенной может быть одна: без
    // единого поля своей системы кандидат не заводится.
    const anything = read.token || Object.values(read.fields).some(Boolean);
    if (!anything && launched.launch !== 'url') continue;
    found.push({ id: signature.id, ...read });
  }
  return found;
}
