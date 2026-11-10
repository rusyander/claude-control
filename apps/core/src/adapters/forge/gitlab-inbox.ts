import type { Fact } from '@agentdeck/contracts/core/facts';
import type { ForgeInbox, ForgeInboxMr, ForgeIssue } from '@agentdeck/contracts/core/forge';
import type { ForgeAccess } from './forge.types.ts';
import { asArray, forgeCall, isRecord, readList, unknownReason } from './http.ts';
import { gitlabInboxMr, gitlabIssue, gitlabIssueLinks, gitlabOpenThreads } from './gitlab-map.ts';

/**
 * Чтения входящих GitLab (этап 12, D16) с правами учётки человека, по всему сайту: задачи,
 * назначенные мне, с метками и связями; MR, где я ревьюер; мои открытые MR с нерешёнными нитями.
 * Списки новые первыми, страницами по 100; потолок страниц не дошёл до конца списка — `unknown`,
 * а не молча срезанный список (запись входящих, выпавшая за потолок, выглядела бы закрытой).
 */

export const INBOX_PAGE = 100;
/** Потолок страниц одного списка входящих: 500 записей — больше человек не разберёт. */
export const INBOX_MAX_PAGES = 5;

/** Одна страница → разобранные строки; не та форма — `null` (порт скажет `garbage`). */
type PageParse<T> = (row: unknown) => T | null;

export function createGitlabInbox(access: ForgeAccess, maxPages = INBOX_MAX_PAGES): ForgeInbox {
  const api = `${access.project.baseUrl.replace(/\/+$/, '')}/api/v4`;
  const get = (url: string) => forgeCall(access, api, { method: 'GET', url });

  /** Все страницы списка: короткая страница — конец; потолок без конца — `unknown`. */
  async function pages<T>(
    path: string,
    params: Record<string, string>,
    where: string,
    parse: PageParse<T>,
  ): Promise<Fact<T[]>> {
    const out: T[] = [];
    for (let n = 1; n <= maxPages; n += 1) {
      const query = new URLSearchParams({ ...params, per_page: String(INBOX_PAGE), page: `${n}` });
      const reply = await get(`${path}?${query}`);
      if (reply.kind !== 'ok') return { unknown: unknownReason(reply, where) };
      const rows = asArray(reply.body);
      if (!rows) return { unknown: `${where}: garbage (unexpected reply shape)` };
      for (const row of rows) {
        const one = parse(row);
        if (one === null) return { unknown: `${where}: garbage (unexpected reply shape)` };
        out.push(one);
      }
      if (rows.length < INBOX_PAGE) return { value: out };
    }
    return { unknown: `${where}: more than ${maxPages} pages of ${INBOX_PAGE} (page cap)` };
  }

  const projectPath = (project: string) => `/projects/${encodeURIComponent(project)}`;

  async function me(): Promise<Fact<string>> {
    return readList(await get('/user'), 'GET /user', (v) =>
      isRecord(v) && typeof v.username === 'string' ? v.username : null,
    );
  }

  /** Нерешённые нити MR по всем страницам обсуждений. */
  async function openThreadsOf(mr: ForgeInboxMr): Promise<Fact<number>> {
    const where = `GET merge_requests/${mr.iid}/discussions`;
    const path = `${projectPath(mr.project)}/merge_requests/${mr.iid}/discussions`;
    const all = await pages(path, {}, where, (row) => row);
    if (!('value' in all)) return all;
    // Разбор нитей общий с портом: системные заметки отброшены, «решена» — каждая разрешимая.
    const open = gitlabOpenThreads(all.value);
    return open === null
      ? { unknown: `${where}: garbage (unexpected reply shape)` }
      : { value: open };
  }

  async function linksOf(issue: ForgeIssue): Promise<Fact<string[]>> {
    const where = `GET issues/${issue.iid}/links`;
    const reply = await get(`${projectPath(issue.project)}/issues/${issue.iid}/links`);
    return readList(reply, where, gitlabIssueLinks);
  }

  return {
    kind: 'gitlab',

    async assignedIssues(q) {
      // «Только назначенные на меня» выключено — задачи с метками по всему сайту, чьи угодно (как
      // у Jira: метки и исполнитель — два независимых условия источника).
      const anyone = q.assignedToMe === false && q.labels.length > 0;
      const params: Record<string, string> = {
        scope: anyone ? 'all' : 'assigned_to_me',
        state: 'opened',
        order_by: 'created_at',
        sort: 'desc',
      };
      if (q.labels.length > 0) params.labels = q.labels.join(',');
      const listed = await pages('/issues', params, 'GET issues', (row) => {
        const issue = gitlabIssue(row);
        return issue ? { row, issue } : null;
      });
      if (!('value' in listed)) return listed;
      // Фильтр сервера не доказательство: у задачи должна быть КАЖДАЯ названная метка.
      const wanted = listed.value.filter(({ issue }) =>
        q.labels.every((l) => issue.labels.includes(l)),
      );
      const out: ForgeIssue[] = [];
      for (const { row, issue } of wanted) {
        // Связи — часть отпечатка: непрочитанные дали бы «тикет изменён» без правки.
        const links = await linksOf(issue);
        if (!('value' in links)) return links;
        out.push(gitlabIssue(row, links.value) ?? issue);
      }
      return { value: out };
    },

    async reviewRequests() {
      const who = await me();
      if (!('value' in who)) return who;
      return pages(
        '/merge_requests',
        {
          scope: 'all',
          state: 'opened',
          reviewer_username: who.value,
          order_by: 'created_at',
          sort: 'desc',
        },
        'GET merge_requests (reviewer)',
        (row) => gitlabInboxMr(row, 0),
      );
    },

    async ownMrsWithOpenThreads() {
      const listed = await pages(
        '/merge_requests',
        { scope: 'created_by_me', state: 'opened', order_by: 'created_at', sort: 'desc' },
        'GET merge_requests (own)',
        (row) => (isRecord(row) ? { row, mr: gitlabInboxMr(row, 0) } : null),
      );
      if (!('value' in listed)) return listed;
      const out: ForgeInboxMr[] = [];
      for (const { row, mr } of listed.value) {
        if (!mr) return { unknown: 'GET merge_requests (own): garbage (unexpected reply shape)' };
        const open = await openThreadsOf(mr);
        if (!('value' in open)) return open;
        if (open.value === 0) continue;
        const full = gitlabInboxMr(row, open.value);
        if (full) out.push(full);
      }
      return { value: out };
    },
  };
}
