import type { TmsPushResult } from '@agentdeck/contracts';
import { invalidField } from '../errors.ts';
import { requestJson } from '../http.ts';
import type { TmsCaseBatch, TmsClient, TmsRunPush } from './types.ts';
import { serverText } from '../../../lib/server-texts.ts';

/**
 * Zephyr Scale (облако): кейсы и циклы поверх собственного REST.
 *
 * Токен один, `Authorization: Bearer`, выдаётся в самом Zephyr и с учётной
 * записью Jira не связан: адрес API у него отдельный и общий на всех
 * (`api.zephyrscale.smartbear.com`), поэтому ни адреса сайта, ни почты здесь не
 * нужно — достаточно ключа проекта.
 *
 * Отправка прогона — это ЦИКЛ плюс по выполнению на кейс: одним документом, как
 * у Xray, Zephyr результаты не принимает.
 */

const API = 'https://api.zephyrscale.smartbear.com/v2';
const SYSTEM = 'Zephyr Scale';

/** Сколько кейсов запрашиваем одной страницей и сколько их берём всего. */
const PAGE = 200;
const MAX_ITEMS = 2000;

/** Статусы панели → названия статусов Zephyr. Остальное — «Not Executed». */
const STATUS: Record<string, string> = {
  passed: 'Pass',
  failed: 'Fail',
  blocked: 'Blocked',
  skipped: 'Not Executed',
  unknown: 'Not Executed',
};

interface ZephyrCase {
  key: string;
  name: string;
  objective?: string;
  precondition?: string;
  testScript?: { steps?: { description?: string; expectedResult?: string; testData?: string }[] };
}

function headers(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}`, Accept: 'application/json' };
}

function jsonHeaders(token: string): Record<string, string> {
  return { ...headers(token), 'Content-Type': 'application/json' };
}

export function zephyrClient(token: string, projectKey: string): TmsClient {
  const key = projectKey.trim();
  if (!key)
    throw invalidField(
      'projectKey',
      'не указан ключ проекта Jira',
      'request-jira-project-key-missing',
      { field: 'projectKey' },
    );

  return {
    kind: 'zephyr',
    title: SYSTEM,

    /** Одна страница в один кейс: ключ рабочий и проект виден — этого хватает. */
    async ping(): Promise<string> {
      await requestJson<{ values?: ZephyrCase[] }>({
        url: `${API}/testcases?projectKey=${encodeURIComponent(key)}&maxResults=1`,
        system: SYSTEM,
        headers: headers(token),
      });
      return serverText('integration-tms-project', { system: SYSTEM, project: key });
    },

    /**
     * Кейсы проекта постранично. Раньше здесь стоял один запрос на 200, и
     * проект больше двухсот кейсов приезжал обрезанным МОЛЧА — ответ выглядел
     * как «привезли всё». Потолок остался, но теперь он называется вслух.
     */
    async pullCases(): Promise<TmsCaseBatch> {
      const values: ZephyrCase[] = [];
      let truncated = true;
      for (let startAt = 0; startAt < MAX_ITEMS; startAt += PAGE) {
        const page = await requestJson<{ values?: ZephyrCase[]; isLast?: boolean }>({
          url: `${API}/testcases?projectKey=${encodeURIComponent(key)}&maxResults=${PAGE}&startAt=${startAt}`,
          system: SYSTEM,
          headers: headers(token),
        });
        const items = page.values ?? [];
        values.push(...items);
        if (page.isLast === true || items.length < PAGE) {
          truncated = false;
          break;
        }
      }
      const cases = values.map((item) => ({
        key: item.key,
        title: item.name,
        // Цель кейса Zephyr — это ближайшее к предусловию, что у него есть.
        precondition: item.precondition ?? item.objective,
        steps: (item.testScript?.steps ?? []).map((step) => ({
          action: step.description ?? '',
          expected: step.expectedResult,
          data: step.testData,
        })),
      }));
      return { cases, truncated };
    },

    /**
     * Прогон → цикл + выполнения. Кейс без пометки `tms:` пропускается: его
     * ключа во внешней системе нет, а придумывать соответствие панель не имеет
     * права — чужой отчёт получил бы результат не того теста.
     *
     * Повторная отправка того же прогона кладёт выполнения в УЖЕ заведённый
     * цикл (`externalRunId`): новый цикл на каждое нажатие превратил бы один
     * прогон панели в несколько прогонов в отчёте команды.
     */
    async pushRun(push: TmsRunPush): Promise<TmsPushResult> {
      const reused = Boolean(push.externalRunId);
      const cycleKey = reused
        ? String(push.externalRunId)
        : (
            await requestJson<{ key?: string }>({
              url: `${API}/testcycles`,
              method: 'POST',
              system: SYSTEM,
              headers: jsonHeaders(token),
              body: JSON.stringify({
                projectKey: key,
                name: `agentdeck ${push.run.startedAt}`,
                description: `Прогон панели: ${push.run.mode}${
                  push.run.branch ? `, ветка ${push.run.branch}` : ''
                }`,
              }),
            })
          ).key;

      // Цикл заведён, выполнений в нём ещё нет: дальше идёт по запросу на
      // каждый результат, и отказ на любом из них раньше уносил с собой сам
      // факт создания — повторная отправка заводила В ZEPHYR ВТОРОЙ ЦИКЛ.
      if (!reused && cycleKey) push.onRunCreated?.(cycleKey, `${API}/testcycles/${cycleKey}`);

      let pushed = 0;
      for (const result of push.run.results) {
        const caseKey = push.keyOf(result);
        if (!caseKey) continue;
        await requestJson<unknown>({
          url: `${API}/testexecutions`,
          method: 'POST',
          system: SYSTEM,
          headers: jsonHeaders(token),
          body: JSON.stringify({
            projectKey: key,
            testCaseKey: caseKey,
            testCycleKey: cycleKey,
            statusName: STATUS[result.status] ?? 'Not Executed',
            comment: result.note ?? '',
          }),
        });
        pushed += 1;
      }

      return {
        pushed,
        runId: cycleKey || undefined,
        reused,
        url: cycleKey ? `${API}/testcycles/${cycleKey}` : undefined,
      };
    },
  };
}
