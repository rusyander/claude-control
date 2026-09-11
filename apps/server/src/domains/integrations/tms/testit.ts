import type { TmsPushResult } from '@agentdeck/contracts';
import { invalidField } from '../errors.ts';
import { requestJson } from '../http.ts';
import type { TmsCase, TmsCaseBatch, TmsClient, TmsRunPush } from './types.ts';

/**
 * Test IT: своя установка, `PrivateToken` и ран из выбранных кейсов.
 *
 * Отличий от двух облачных ровно три, и каждое видно снаружи.
 *
 * АДРЕС СВОЙ. Test IT ставят себе, общего хоста у него нет — поэтому у карточки
 * появилось поле адреса, и без него клиент не собирается вовсе. Пути идут от
 * `/api/v2`.
 *
 * КЛЮЧ ИДЁТ ЦЕЛИКОМ В ЗАГОЛОВОК `Authorization: PrivateToken <ключ>` — это не
 * `Bearer`, и перепутанная схема даёт 401, который человек читает как «ключ не
 * тот». Схему подставляет панель, чтобы её нельзя было ввести неправильно.
 *
 * СОСТАВ РАНА ВЫБОРОЧНЫЙ. У Zephyr цикл заводится пустым, у Test IT ран
 * собирается ИЗ КЕЙСОВ, и в него кладутся только те, что были в прогоне панели:
 * ран на весь проект показал бы сотни «не выполнено» рядом с десятком реальных
 * результатов и обесценил бы отчёт.
 *
 * Кейс живёт «рабочим элементом» (work item) и имеет два идентификатора: guid,
 * которым его знает API, и `globalId` — то число, которое человек видит в
 * интерфейсе и назовёт в разговоре. Пометка на кейсе панели (`tms:<ключ>`)
 * хранит ВТОРОЕ: тег читают люди. Guid'ы поднимаются по нему одним поиском на
 * отправку.
 *
 * Формы запросов взяты из документированного API v2 и прогонялись на заглушке:
 * живой установки Test IT у панели нет. Поэтому все обращения собраны здесь и
 * только здесь — правка формы под конкретную версию сервера остаётся одной
 * правкой в одном файле.
 */

const SYSTEM = 'Test IT';

/** Сколько кейсов запрашиваем одной страницей. */
const PAGE = 200;

/**
 * Потолок выборки кейсов проекта. Он есть, потому что за каждым кейсом идёт
 * ещё один запрос за шагами, и «забрать всё» у проекта на десять тысяч кейсов
 * означало бы десять тысяч запросов чужой квоты по одному нажатию.
 *
 * Но МОЛЧА он не срабатывает. Раньше здесь стоял один запрос на 200 кейсов, и
 * проект больше двухсот приезжал обрезанным без единого слова, а отправка,
 * поднимая guid'ы тем же запросом, не находила кейс за границей страницы и
 * винила в этом пометки: «проверьте, что „tms:“ из этого проекта». Теперь
 * страницы листаются до потолка, а сам потолок называется вслух.
 */
const MAX_ITEMS = 2000;

/** Статусы панели → исходы Test IT. Остальное — «Skipped», а не выдумка. */
const OUTCOME: Record<string, string> = {
  passed: 'Passed',
  failed: 'Failed',
  blocked: 'Blocked',
  skipped: 'Skipped',
  unknown: 'Skipped',
};

interface WorkItemShort {
  id?: string;
  globalId?: number | string;
  name?: string;
}

interface WorkItemFull extends WorkItemShort {
  description?: string;
  preconditionSteps?: { action?: string; expected?: string; testData?: string }[];
  steps?: { action?: string; expected?: string; testData?: string }[];
}

interface TestRunResult {
  id?: string;
  workItemGlobalId?: number | string;
  testPoint?: { workItemGlobalId?: number | string; workItemId?: string };
  workItem?: { globalId?: number | string; id?: string };
}

/** Адрес установки без хвостовой косой и с обязательной схемой. */
function apiRoot(baseUrl: string): string {
  const value = baseUrl.trim().replace(/\/+$/, '');
  if (!value) {
    throw invalidField('baseUrl', 'не указан адрес Test IT: у своей установки он у каждого свой');
  }
  if (!/^https?:\/\//i.test(value)) {
    throw invalidField('baseUrl', 'адрес Test IT должен начинаться с http:// или https://');
  }
  return `${value}/api/v2`;
}

function headers(token: string): Record<string, string> {
  return { Authorization: `PrivateToken ${token}`, Accept: 'application/json' };
}

function jsonHeaders(token: string): Record<string, string> {
  return { ...headers(token), 'Content-Type': 'application/json' };
}

/** `globalId` как строка: в ответах он число, а в теге кейса — текст. */
function globalIdOf(item: { globalId?: number | string }): string {
  const value = item.globalId;
  return value === undefined || value === null ? '' : String(value);
}

/** Ключ результата рана: у разных версий он лежит в разных местах ответа. */
function resultKey(result: TestRunResult): string {
  return (
    globalIdOf({ globalId: result.workItemGlobalId }) ||
    globalIdOf({ globalId: result.testPoint?.workItemGlobalId }) ||
    globalIdOf({ globalId: result.workItem?.globalId })
  );
}

export function testitClient(token: string, projectKey: string, baseUrl: string): TmsClient {
  const api = apiRoot(baseUrl);
  const project = projectKey.trim();
  if (!project) throw invalidField('projectKey', 'не указан проект Test IT');

  const site = api.replace(/\/api\/v2$/, '');
  /** Адрес рана в интерфейсе Test IT — он же уходит в предварительную отметку. */
  const runUrl = (runId: string): string =>
    `${site}/projects/${encodeURIComponent(project)}/testRuns/${encodeURIComponent(runId)}`;

  /**
   * Короткий список кейсов проекта — им же поднимаются guid'ы по `globalId`.
   * Страницы листаются до потолка; упёрлись — это сказано, а не проглочено.
   */
  const searchWorkItems = async (): Promise<{ items: WorkItemShort[]; truncated: boolean }> => {
    const items: WorkItemShort[] = [];
    for (let skip = 0; skip < MAX_ITEMS; skip += PAGE) {
      const found = await requestJson<WorkItemShort[] | { items?: WorkItemShort[] }>({
        url: `${api}/workItems/search?skip=${skip}&take=${PAGE}`,
        method: 'POST',
        system: SYSTEM,
        headers: jsonHeaders(token),
        body: JSON.stringify({
          filter: { projectIds: [project], isDeleted: false },
        }),
      });
      const page = Array.isArray(found) ? found : (found?.items ?? []);
      items.push(...page);
      // Неполная страница — конец списка. Это единственный признак, общий для
      // обеих форм ответа: голый массив счётчика `total` не несёт.
      if (page.length < PAGE) return { items, truncated: false };
    }
    return { items, truncated: true };
  };

  return {
    kind: 'testit',
    title: SYSTEM,

    /**
     * Проверка — сам проект, а не список кейсов: один дешёвый запрос отвечает
     * сразу на оба вопроса человека, «пустили ли» и «тот ли проект».
     */
    async ping(): Promise<string> {
      const info = await requestJson<{ name?: string }>({
        url: `${api}/projects/${encodeURIComponent(project)}`,
        system: SYSTEM,
        headers: headers(token),
      });
      return `${SYSTEM}, проект ${info?.name?.trim() || project}`;
    },

    /**
     * Кейсы вместе с шагами. Список отдаётся без шагов, поэтому за каждым идёт
     * ещё один запрос — это цена формата, а не небрежность; потолок в
     * `PULL_LIMIT` кейсов стоит здесь именно поэтому.
     */
    async pullCases(): Promise<TmsCaseBatch> {
      const { items, truncated } = await searchWorkItems();
      const cases: TmsCase[] = [];

      for (const item of items) {
        const key = globalIdOf(item);
        if (!item.id || !key) continue;
        const full = await requestJson<WorkItemFull>({
          url: `${api}/workItems/${encodeURIComponent(item.id)}`,
          system: SYSTEM,
          headers: headers(token),
        });
        const precondition = (full?.preconditionSteps ?? [])
          .map((step) => step.action?.trim())
          .filter((line): line is string => Boolean(line))
          .join('\n');

        cases.push({
          key,
          title: full?.name?.trim() || item.name?.trim() || 'Без названия',
          precondition: precondition || full?.description?.trim() || undefined,
          steps: (full?.steps ?? []).map((step) => ({
            action: step.action ?? '',
            expected: step.expected,
            data: step.testData,
          })),
          url: `${api.replace(/\/api\/v2$/, '')}/projects/${encodeURIComponent(project)}/tests/${encodeURIComponent(key)}`,
        });
      }

      return { cases, truncated };
    },

    /**
     * Прогон → ран из тех кейсов, что в нём были, и результат на каждый.
     *
     * Повторная отправка ТОГО ЖЕ прогона попадает в ран, заведённый в прошлый
     * раз (`externalRunId`), и переписывает его результаты: заводить второй ран
     * значило бы, что в чужом отчёте один прогон панели считается за два.
     */
    async pushRun(push: TmsRunPush): Promise<TmsPushResult> {
      const wanted = new Map<string, string>();
      for (const result of push.run.results) {
        const key = push.keyOf(result);
        if (key) wanted.set(key, OUTCOME[result.status] ?? 'Skipped');
      }
      if (wanted.size === 0) return { pushed: 0 };

      const notes = new Map<string, string>();
      for (const result of push.run.results) {
        const key = push.keyOf(result);
        if (key && result.note) notes.set(key, result.note);
      }

      /** Кейсы прогона, которых нет в этом проекте Test IT. */
      let notFound: string[] = [];

      /** Новый ран ровно из кейсов прогона: guid'ы поднимаются по `globalId`. */
      const createRun = async (): Promise<string> => {
        const { items, truncated } = await searchWorkItems();
        const byGlobalId = new Map<string, string>();
        for (const item of items) {
          const key = globalIdOf(item);
          if (item.id && key) byGlobalId.set(key, item.id);
        }
        const missing = [...wanted.keys()].filter((key) => !byGlobalId.has(key));
        const workItemIds = [...wanted.keys()]
          .map((key) => byGlobalId.get(key))
          .filter((id): id is string => Boolean(id));
        // Обрезанный список — не то же самое, что чужие пометки, и советовать
        // при нём «проверьте „tms:“» значит отправить человека чинить не то.
        const because = truncated
          ? `список кейсов проекта обрезан на ${MAX_ITEMS} — кейс мог остаться за этой границей`
          : 'проверьте, что пометки «tms:» из этого проекта, а не из другого';
        if (workItemIds.length === 0) {
          throw invalidField(
            'projectKey',
            `${SYSTEM}: ни один кейс прогона не найден в этом проекте — ${because}`,
          );
        }
        // Часть кейсов не нашлась. Отправку это не отменяет — из-за одной
        // устаревшей пометки терять весь прогон незачем, — но и пропасть молча
        // не должно: ключи уезжают в ответ и оттуда на экран.
        notFound = missing;

        const created = await requestJson<{ id?: string }>({
          url: `${api}/testRuns/byWorkItems`,
          method: 'POST',
          system: SYSTEM,
          headers: jsonHeaders(token),
          body: JSON.stringify({
            projectId: project,
            name: `agentdeck ${push.run.startedAt}`,
            description: `Прогон панели: ${push.run.mode}${
              push.run.branch ? `, ветка ${push.run.branch}` : ''
            }`,
            workItemIds,
          }),
        });
        const id = created?.id?.trim();
        if (!id) throw invalidField('projectKey', `${SYSTEM} не вернул идентификатор рана`);
        return id;
      };

      const reused = Boolean(push.externalRunId);
      const runId = reused ? String(push.externalRunId) : await createRun();
      // Ран уже заведён, а результаты ещё нет. Отказ на любом из следующих
      // запросов не должен стоить панели знания о нём: без этой отметки
      // повторная отправка завела бы В TEST IT ВТОРОЙ РАН на тот же прогон.
      if (!reused) push.onRunCreated?.(runId, runUrl(runId));
      const results = await requestJson<{ testResults?: TestRunResult[] }>({
        url: `${api}/testRuns/${encodeURIComponent(runId)}`,
        system: SYSTEM,
        headers: headers(token),
      });

      let pushed = 0;
      for (const result of results?.testResults ?? []) {
        const key = resultKey(result);
        const outcome = wanted.get(key);
        if (!result.id || !outcome) continue;
        await requestJson<unknown>({
          url: `${api}/testResults/${encodeURIComponent(result.id)}`,
          method: 'PUT',
          system: SYSTEM,
          headers: jsonHeaders(token),
          body: JSON.stringify({ outcome, comment: notes.get(key) ?? '' }),
        });
        pushed += 1;
      }

      return {
        pushed,
        runId,
        reused,
        url: runUrl(runId),
        missing: notFound.length > 0 ? notFound : undefined,
      };
    },
  };
}
