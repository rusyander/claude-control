import type { InboxSystem } from '@agentdeck/contracts/core/inbox';

/**
 * Черновик одного источника в окне: списки — как человек их набрал (текстом), чтобы поле не
 * «съедало» запятую на полуслове; в раздел `inbox` они превращаются только при записи.
 */
export interface SourceDraft {
  /** Ключ строки в окне — не меняется, когда человек правит имя. */
  key: string;
  id: string;
  system: InboxSystem;
  enabled: boolean;
  autoQueue: boolean;
  /** Метки: у Jira — метки тикетов, у GitLab — метки задач. Через запятую. */
  labels: string;
  /** У Jira — «назначенные на меня», у GitLab — задачи, назначенные на меня. */
  assignedToMe: boolean;
  /** Свой JQL (только Jira); пусто — нет. */
  jql: string;
  reviewerMrs: boolean;
  ownMrsWithThreads: boolean;
  /** Строки «путь на форже = локальная папка». */
  repos: string;
  bugLabels: string;
}

/** Черновик всего раздела: источники, частота опроса в минутах, ответ в тикет. */
export interface InboxDraft {
  sources: SourceDraft[];
  pollMinutes: number;
  commentBack: boolean;
}

/**
 * Почему черновик не записать: код текста `coreInbox.sources.problems.<code>` и его подстановки;
 * `field` — ключ `coreInbox.sources.problems.fields.<field>`, окно переводит его само.
 */
export interface SourceProblem {
  code: 'id' | 'duplicate' | 'repos' | 'schema' | 'tooLong' | 'tooMany' | 'empty';
  values: Record<string, string>;
}

/** Поле источника, которое назвала схема ядра. */
export type SourceField = 'labels' | 'jql' | 'repos' | 'bugLabels' | 'other';
