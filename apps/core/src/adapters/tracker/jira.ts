import { isTrackerError, type TrackerError, type TrackerSend } from '@agentdeck/trackers';
import { sendOver } from '@agentdeck/trackers/client';
import { commentIssue, searchIssues } from '@agentdeck/trackers/jira';
import { coreTransport, describeTransport } from './transport.ts';
import type { CoreTracker, TrackerAccess } from './tracker.types.ts';

/**
 * Jira для ядра поверх общего клиента (`@agentdeck/trackers/jira`): порт отправки собирается
 * один раз, токен — только в его замыкании и в заголовке `Authorization`. Отказ трекера —
 * «неизвестно» с кодом (`unauthorized`, `server-error` …) и действием, не текстом ответа.
 */

const SEARCH_LIMIT = 50;
/**
 * 429 на комментарий: ограничитель трекера отвечает ДО записи, комментария нет — повтор не делает
 * второй (P166 запрещает повтор только там, где исход неизвестен: сеть, срок, 5xx). Всего попыток
 * не больше трёх; ждём `Retry-After`, без него — 2 с; срок дольше потолка — отказ сразу: держать
 * публикацию минутами ради комментария нельзя, а отказ человек видит в журнале действия.
 */
const COMMENT_ATTEMPTS = 3;
const COMMENT_WAIT_DEFAULT_MS = 2_000;
const COMMENT_WAIT_CAP_MS = 30_000;

const timer = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));

const rateLimited = (error: unknown): error is TrackerError =>
  isTrackerError(error) && error.code === 'rate-limited';

function reasonOf(where: string, error: unknown): string {
  if (isTrackerError(error))
    return `jira ${where}: ${error.code}${error.status === undefined ? '' : ` (http ${error.status})`}`;
  if (error instanceof RangeError) return `jira ${where}: ${error.message}`;
  return `jira ${where}: ${describeTransport(error)}`;
}

export function createJiraTracker(access: TrackerAccess): CoreTracker {
  const missing = access.tokenProblem ?? 'no jira credential stored in the panel';
  const send: TrackerSend | null = access.token
    ? sendOver(coreTransport(access.fetch, access.timeoutMs), {
        deployment: access.site.deployment,
        email: access.email,
        token: access.token,
      })
    : null;

  return {
    system: 'jira',
    async search(q) {
      if (!send) return { unknown: `jira search: ${missing}` };
      const limit = Math.min(Math.max(q.limit ?? SEARCH_LIMIT, 1), 100);
      try {
        const issues = await searchIssues(access.site, send, {
          jql: q.jql,
          limit,
          related: true,
        });
        return { value: { issues, truncated: issues.length >= limit } };
      } catch (error) {
        const reason = reasonOf('search', error);
        const after = isTrackerError(error) ? error.retryAfterMs : undefined;
        return after === undefined ? { unknown: reason } : { unknown: reason, retryAfterMs: after };
      }
    },
    async comment(key, body) {
      if (!send) return { unknown: `jira comment: ${missing}` };
      const sleep = access.sleep ?? timer;
      try {
        for (let attempt = 1; ; attempt += 1) {
          try {
            await commentIssue(access.site, send, key, body);
            return { value: true };
          } catch (error) {
            const wait = rateLimited(error)
              ? (error.retryAfterMs ?? COMMENT_WAIT_DEFAULT_MS)
              : null;
            if (wait === null || attempt >= COMMENT_ATTEMPTS || wait > COMMENT_WAIT_CAP_MS)
              throw error;
            await sleep(wait);
          }
        }
      } catch (error) {
        // Ответ 4xx — трекер отказал по существу: комментария нет, повтор тем же телом не поможет.
        if (isTrackerError(error) && error.status !== undefined && error.status < 500)
          return { refused: reasonOf('comment', error), status: error.status };
        return { unknown: reasonOf('comment', error) };
      }
    },
  };
}
