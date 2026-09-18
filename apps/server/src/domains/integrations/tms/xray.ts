import type { TmsPushResult } from '@agentdeck/contracts';
import { invalidField } from '../errors.ts';
import { requestJson } from '../http.ts';
import type { TmsCaseBatch, TmsClient, TmsRunPush } from './types.ts';
import { serverText } from '../../../lib/server-texts.ts';

/**
 * Xray (облако): импорт результатов документом и чтение кейсов через GraphQL.
 *
 * Токен здесь ПАРНЫЙ — `client_id:client_secret`, — и хранится он одной строкой
 * с двоеточием: у панели одно поле токена на интеграцию, а заводить второе ради
 * одной системы значило бы усложнить форму всем пятерым. Пара меняется на JWT
 * ровно на время операции и никуда не сохраняется.
 *
 * Статусы отправляются документом Xray JSON — так у него принято, и это ровно
 * один запрос вместо выполнения на кейс.
 */

const API = 'https://xray.cloud.getxray.app/api/v2';
const SYSTEM = 'Xray';

/** Страница `getTests` (у Xray это её потолок) и общий потолок выборки. */
const PAGE = 100;
const MAX_ITEMS = 2000;

/** Статусы панели → статусы Xray. Остальное — «TODO». */
const STATUS: Record<string, string> = {
  passed: 'PASSED',
  failed: 'FAILED',
  blocked: 'FAILED',
  skipped: 'TODO',
  unknown: 'TODO',
};

/** Пара из одного поля: `clientId:clientSecret`. */
function splitToken(token: string): { clientId: string; clientSecret: string } {
  const at = token.indexOf(':');
  if (at <= 0) {
    throw invalidField(
      'token',
      'токен Xray задаётся парой «clientId:clientSecret» через двоеточие',
      'request-xray-token-pair',
      { field: 'token' },
    );
  }
  return { clientId: token.slice(0, at).trim(), clientSecret: token.slice(at + 1).trim() };
}

/**
 * JWT на время операции. Xray отвечает строкой в кавычках — это валидный JSON,
 * поэтому разбор общий, а кавычки снимаются здесь.
 */
async function authenticate(token: string): Promise<string> {
  const { clientId, clientSecret } = splitToken(token);
  const jwt = await requestJson<string>({
    url: `${API}/authenticate`,
    method: 'POST',
    system: SYSTEM,
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ client_id: clientId, client_secret: clientSecret }),
  });
  const value = String(jwt ?? '').replace(/^"|"$/g, '');
  if (!value)
    throw invalidField('token', 'Xray не выдал ключ по этой паре', 'request-xray-no-key', {
      field: 'token',
    });
  return value;
}

interface XrayTestNode {
  issueId?: string;
  jira?: { key?: string; summary?: string };
  steps?: { action?: string; result?: string; data?: string }[];
}

export function xrayClient(token: string, projectKey: string): TmsClient {
  const key = projectKey.trim();
  if (!key)
    throw invalidField(
      'projectKey',
      'не указан ключ проекта Jira',
      'request-jira-project-key-missing',
      { field: 'projectKey' },
    );

  return {
    kind: 'xray',
    title: SYSTEM,

    /** Проверка = выдача JWT: пара принята, значит связь есть. */
    async ping(): Promise<string> {
      await authenticate(token);
      return serverText('integration-tms-project', { system: SYSTEM, project: key });
    },

    /**
     * Кейсы Xray живут задачами Jira, и единственный способ достать их вместе с
     * шагами — GraphQL самого Xray. JQL здесь именно фильтр проекта, а не поиск
     * по тексту: забирается весь набор проекта, дальше отбирает человек.
     */
    async pullCases(): Promise<TmsCaseBatch> {
      const jwt = await authenticate(token);
      const nodes: XrayTestNode[] = [];
      let truncated = true;
      // Раньше здесь стоял один запрос на 100 кейсов, и проект больше сотни
      // приезжал обрезанным молча. `start` — штатная страница `getTests`.
      for (let start = 0; start < MAX_ITEMS; start += PAGE) {
        const query = `query { getTests(jql: "project = ${key}", limit: ${PAGE}, start: ${start}) { results { issueId jira(fields: ["key", "summary"]) steps { action result data } } } }`;
        const payload = await requestJson<{
          data?: { getTests?: { results?: XrayTestNode[] } };
          errors?: { message?: string }[];
        }>({
          url: `${API}/graphql`,
          method: 'POST',
          system: SYSTEM,
          headers: {
            Authorization: `Bearer ${jwt}`,
            'Content-Type': 'application/json',
            Accept: 'application/json',
          },
          body: JSON.stringify({ query }),
        });

        const failure = payload.errors?.[0]?.message;
        if (failure)
          throw invalidField('projectKey', `Xray отказал: ${failure}`, 'request-xray-refused', {
            field: 'projectKey',
            failure,
          });

        const results = payload.data?.getTests?.results ?? [];
        nodes.push(...results);
        if (results.length < PAGE) {
          truncated = false;
          break;
        }
      }

      const cases = nodes.map((node) => ({
        key: node.jira?.key ?? String(node.issueId ?? ''),
        title: node.jira?.summary ?? 'Без названия',
        steps: (node.steps ?? []).map((step) => ({
          action: step.action ?? '',
          expected: step.result,
          data: step.data,
        })),
      }));
      return { cases, truncated };
    },

    /**
     * Весь прогон одним документом: у Xray это штатный импорт результатов.
     *
     * Повторная отправка того же прогона называет уже созданное выполнение
     * (`testExecutionKey`) и обновляет его: без этого каждое нажатие заводило бы
     * в Jira новую задачу-выполнение с теми же результатами.
     */
    async pushRun(push: TmsRunPush): Promise<TmsPushResult> {
      const jwt = await authenticate(token);
      const tests = push.run.results
        .map((result) => ({ key: push.keyOf(result), result }))
        .filter((item): item is { key: string; result: (typeof push.run.results)[number] } =>
          Boolean(item.key),
        )
        .map((item) => ({
          testKey: item.key,
          status: STATUS[item.result.status] ?? 'TODO',
          comment: item.result.note ?? '',
        }));

      if (tests.length === 0) return { pushed: 0 };

      const reused = Boolean(push.externalRunId);
      const created = await requestJson<{ key?: string; self?: string }>({
        url: `${API}/import/execution`,
        method: 'POST',
        system: SYSTEM,
        headers: {
          Authorization: `Bearer ${jwt}`,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify({
          testExecutionKey: push.externalRunId,
          info: {
            project: key,
            summary: `agentdeck ${push.run.startedAt}`,
            description: `Прогон панели: ${push.run.mode}${
              push.run.branch ? `, ветка ${push.run.branch}` : ''
            }`,
            startDate: push.run.startedAt,
            finishDate: push.run.finishedAt ?? push.run.startedAt,
          },
          tests,
        }),
      });

      return {
        pushed: tests.length,
        runId: created?.key ?? push.externalRunId,
        reused,
        url: created?.self,
      };
    },
  };
}
