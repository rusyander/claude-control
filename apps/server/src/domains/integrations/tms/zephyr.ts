import type { TmsPushResult } from '@agentdeck/contracts';
import { invalidField } from '../errors.ts';
import { requestJson } from '../http.ts';
import type { TmsCase, TmsClient, TmsRunPush } from './types.ts';

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
  if (!key) throw invalidField('projectKey', 'не указан ключ проекта Jira');

  return {
    title: SYSTEM,

    /** Одна страница в один кейс: ключ рабочий и проект виден — этого хватает. */
    async ping(): Promise<string> {
      await requestJson<{ values?: ZephyrCase[] }>({
        url: `${API}/testcases?projectKey=${encodeURIComponent(key)}&maxResults=1`,
        system: SYSTEM,
        headers: headers(token),
      });
      return `${SYSTEM}, проект ${key}`;
    },

    async pullCases(): Promise<TmsCase[]> {
      const page = await requestJson<{ values?: ZephyrCase[] }>({
        url: `${API}/testcases?projectKey=${encodeURIComponent(key)}&maxResults=200`,
        system: SYSTEM,
        headers: headers(token),
      });
      return (page.values ?? []).map((item) => ({
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
    },

    /**
     * Прогон → цикл + выполнения. Кейс без пометки `tms:` пропускается: его
     * ключа во внешней системе нет, а придумывать соответствие панель не имеет
     * права — чужой отчёт получил бы результат не того теста.
     */
    async pushRun(push: TmsRunPush): Promise<TmsPushResult> {
      const cycle = await requestJson<{ key?: string }>({
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
      });

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
            testCycleKey: cycle.key,
            statusName: STATUS[result.status] ?? 'Not Executed',
            comment: result.note ?? '',
          }),
        });
        pushed += 1;
      }

      return { pushed, url: cycle.key ? `${API}/testcycles/${cycle.key}` : undefined };
    },
  };
}
