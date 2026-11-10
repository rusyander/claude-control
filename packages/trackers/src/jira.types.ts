/** Сырой ответ Jira о задаче: поля как есть (у облака описание — документ ADF). */
export interface RawJiraIssue {
  key: string;
  fields?: {
    summary?: string;
    status?: { name?: string; statusCategory?: { key?: string } };
    issuetype?: { name?: string };
    assignee?: { displayName?: string; name?: string };
    updated?: string;
    description?: unknown;
    labels?: unknown;
    priority?: { name?: string };
    parent?: { key?: string; fields?: { summary?: string } };
    issuelinks?: unknown;
  };
}

/** Связь задачи Jira (`issuelinks`): соседняя задача — с одной из двух сторон. */
export interface RawJiraIssueLink {
  type?: { name?: string; outward?: string; inward?: string };
  outwardIssue?: { key?: string };
  inwardIssue?: { key?: string };
}

/** Связь задачи, как её видит вызывающий: ключ соседа, слово связи и сторона. */
export interface TrackerIssueLink {
  key: string;
  /** Слово связи с этой стороны («blocks», «is blocked by»); нет — связь без имени. */
  relation?: string;
  direction: 'inward' | 'outward';
}

/** Задача трекера. Поля карточки панели + то, что нужно входящим ядра (`related: true`). */
export interface TrackerIssue {
  key: string;
  summary: string;
  status: string;
  /** Категория статуса по мнению самой Jira; незнакомое значение — нет поля. */
  statusCategory?: 'new' | 'indeterminate' | 'done';
  type: string;
  assignee?: string;
  updatedAt?: string;
  url: string;
  /** Описание текстом: ADF облака развёрнут. */
  description?: string;
  /** Только при `related: true`: метки, приоритет, родитель (эпик), связи. */
  labels?: string[];
  priority?: string;
  parent?: { key: string; summary?: string };
  links?: TrackerIssueLink[];
}

export interface TrackerProject {
  id: string;
  key: string;
  name: string;
}

export interface TrackerTransition {
  id: string;
  name: string;
  /** Статус, в который переход ведёт. */
  to?: string;
}

/** Поиск задач: готовый JQL (свободный текст переводит `jqlOf`). */
export interface TrackerSearch {
  jql: string;
  /** 1…100, по умолчанию 25. */
  limit?: number;
  /** Читать ещё метки, приоритет, родителя и связи (входящие ядра). */
  related?: boolean;
}

export interface TrackerNewIssue {
  projectKey: string;
  summary: string;
  description: string;
  /** Тип задачи; пусто — «Bug». */
  issueType?: string;
  labels?: string[];
  /** Имя приоритета этой установки; пусто — по умолчанию Jira. */
  priority?: string;
}

/** Ответ `myself`: кто мы для Jira. */
export interface RawJiraMyself {
  displayName?: string;
  name?: string;
  emailAddress?: string;
}
