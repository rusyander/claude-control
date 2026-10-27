import type { JiraIssueBrief } from '../../integrations/atlassian/jira.ts';

/** Откуда панель берёт текст задач группы; в работе — Jira из интеграций. */
export interface TicketSource {
  /** Интеграция подключена — без неё файл не заводится, группа читает трекер сама. */
  connected: () => boolean;
  read: (key: string) => Promise<JiraIssueBrief>;
}

/** Одна задача после чтения: текст или причина, по которой его нет. */
export type TicketRead = { key: string; issue: JiraIssueBrief } | { key: string; reason: string };

/** Что вышло из посева: сколько прочитано, сколько не удалось, лёг ли файл. */
export interface TicketSeedResult {
  written: boolean;
  read: number;
  failed: number;
  /** Время чтения в шапке файла; файла нет — не задано. */
  at?: string;
  /** Что вышло по каждой прочитанной задаче: время обновления в трекере или причина. */
  tickets?: ({ key: string; updatedAt?: string } | { key: string; reason: string })[];
  /** Ключи сверх предела — названы в файле, но не прочитаны. */
  skipped?: string[];
}
