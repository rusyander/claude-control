/** Сырой ответ Jira на `GET /issue/:key?expand=names`: поля как есть и имена полей. */
export interface RawTrackerIssue {
  key?: string;
  fields?: Record<string, unknown> & {
    summary?: unknown;
    description?: unknown;
    status?: { name?: unknown; statusCategory?: { key?: unknown } };
    issuetype?: { name?: unknown };
    priority?: { name?: unknown };
    labels?: unknown;
    assignee?: { displayName?: unknown; name?: unknown };
    updated?: unknown;
    issuelinks?: unknown;
  };
  /** Имя каждого поля по его id (`expand=names`): по нему находится поле критериев. */
  names?: Record<string, unknown>;
}

/** Связь задачи Jira (`issuelinks`): ключ соседней задачи — с одной из двух сторон. */
export interface RawIssueLink {
  type?: { outward?: unknown; inward?: unknown };
  outwardIssue?: { key?: unknown };
  inwardIssue?: { key?: unknown };
}
