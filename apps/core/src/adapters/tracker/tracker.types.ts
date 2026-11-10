import type { Fact } from '@agentdeck/contracts/core/facts';
import type { TrackerSite } from '@agentdeck/trackers/client.types';
import type { TrackerIssue } from '@agentdeck/trackers/jira.types';
import type { NetFetch } from '../../platform/net/net.types.ts';

/**
 * Трекер для ядра (этап 12, D15, P165): чтение задач входящих и одна запись — комментарий назад.
 * Клиент — общий пакет `@agentdeck/trackers` (второго клиента Jira нет); здесь только сеть ядра
 * и перевод отказа в факт. Значение доступа живёт в замыкании порта и в заголовке запроса;
 * причина отказа несёт код и путь, никогда значение доступа или тело ответа.
 */

export interface TrackerAccess {
  site: TrackerSite;
  /** Почта учётки облака; своей установке не нужна. */
  email: string;
  /** `null` — доступа нет: каждое чтение `unknown` с причиной, запись тоже. */
  token: string | null;
  /** Почему доступа нет, если причина не «ключ не сохранён» (хранилище не прочиталось). */
  tokenProblem?: string;
  fetch: NetFetch;
  /** Срок одного запроса; по умолчанию 30 с. */
  timeoutMs?: number;
  /** Ожидание перед повтором комментария после 429; по умолчанию таймер (тест подменяет часы). */
  sleep?: (ms: number) => Promise<void>;
}

/** «Неизвестно» поиска с `Retry-After` трекера (429/503): опрос не стучится раньше этого срока. */
export type TrackerSearchFact = Fact<TrackerFound> | { unknown: string; retryAfterMs: number };

export interface TrackerFound {
  issues: TrackerIssue[];
  /** Ответ упёрся в предел: дальше могут быть ещё задачи. */
  truncated: boolean;
}

/**
 * Исход записи: сделано; отказ трекера по существу (4xx — повтор не поможет без человека);
 * «неизвестно» (сеть, срок, 5xx — записал ли трекер, не узнать, решает сверка).
 */
export type TrackerWrite =
  { value: true } | { refused: string; status: number } | { unknown: string };

export interface CoreTracker {
  readonly system: 'jira';
  /** Поиск по JQL с метками, родителем и связями; пустой JQL — ошибка программы. */
  search(q: { jql: string; limit?: number }): Promise<TrackerSearchFact>;
  comment(key: string, body: string): Promise<TrackerWrite>;
}
