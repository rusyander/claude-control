import { describe, expect, it } from 'vitest';
import { inboxCreateBodySchema, type InboxItem } from '@agentdeck/contracts/core/inbox';
import {
  createBody,
  outcomeOf,
  pickedItems,
  searchFailureOf,
  searchParams,
  searchProblemOf,
  searchViewOf,
  toggleAll,
  togglePick,
} from './inboxSearch.lib';

const item = (key: string): InboxItem => ({
  sourceId: 'jira',
  system: 'jira',
  key,
  kind: 'issue',
  title: `Ticket ${key}`,
  url: `https://tracker.example.com/browse/${key}`,
  labels: ['qa-inbox'],
  digest: 'a'.repeat(64),
  related: { links: [], paths: [] },
});

const items = [item('PROJ-1'), item('PROJ-2'), item('PROJ-3')];
const CMD = '01890000-0000-7000-8000-000000000000';

describe('inbox search', () => {
  it('query goes only as a search parameter, trimmed; empty query is not sent', () => {
    expect(searchParams('jira', '  labels = x  ')).toEqual({ sourceId: 'jira', q: 'labels = x' });
    expect(searchParams('jira', '   ')).toEqual({ sourceId: 'jira' });
  });

  it('create body carries only picked items of one source, valid by the contract schema', () => {
    const body = createBody(
      'jira',
      pickedItems(items, new Set(['PROJ-2', 'PROJ-1'])),
      { nonce: 'n', page: CMD },
      CMD,
    );
    expect(inboxCreateBodySchema.safeParse(body).success).toBe(true);
    expect(body.create).toEqual({
      source: 'search',
      sourceId: 'jira',
      items: [items[0], items[1]],
    });
    expect(JSON.stringify(body)).not.toContain('labels = x');
  });

  it('pick and pick-all toggle', () => {
    const one = togglePick(new Set(), 'PROJ-1');
    expect([...one]).toEqual(['PROJ-1']);
    expect([...togglePick(one, 'PROJ-1')]).toEqual([]);
    const all = toggleAll(one, items);
    expect(all.size).toBe(3);
    expect(toggleAll(all, items).size).toBe(0);
    expect(toggleAll(new Set(), []).size).toBe(0);
  });

  it('view: problem is a reason, not an empty list', () => {
    expect(searchViewOf(undefined)).toBe('none');
    expect(searchViewOf({ items: [], truncated: false, problem: 'tracker answered 503' })).toBe(
      'problem',
    );
    expect(searchViewOf({ items: [], truncated: false })).toBe('empty');
    expect(searchViewOf({ items, truncated: true })).toBe('items');
  });

  it('search refusal is a localized line by the core code; the core prose stays raw for the hint', () => {
    const refused = (status: number, data: Record<string, unknown>) => ({
      response: { status, data },
    });
    expect(
      searchFailureOf(
        refused(404, {
          error: 'Источник входящих не найден',
          code: 'unknown-source',
          reason: 'no inbox source jira-9 in the config',
        }),
      ),
    ).toEqual({ key: 'unknownSource', raw: 'no inbox source jira-9 in the config' });
    expect(searchFailureOf(refused(400, { code: 'bad-inbox-search', error: 'x' })).key).toBe(
      'badQuery',
    );
    expect(searchFailureOf(refused(501, { code: 'not-wired', error: 'x' })).key).toBe('notWired');
    expect(searchFailureOf(new Error('Network Error'))).toEqual({
      key: 'noAnswer',
      raw: 'Network Error',
    });
    expect(searchFailureOf(refused(500, { code: 'whatever', error: 'Boom' }))).toEqual({
      key: 'refused',
      raw: 'Boom',
    });
  });

  it('search problem: the core English prose maps to a known cause, anything else is generic', () => {
    const key = (problem: string) => searchProblemOf(problem).key;
    expect(key('source gh: github inbox reads are not supported (D16): …')).toBe('unsupported');
    expect(key('source jira: source jira names no labels, assignee or JQL')).toBe('noQuery');
    expect(key('source jira: jira search: unauthorized (http 401)')).toBe('auth');
    expect(key('source jira: jira search: forbidden (http 403)')).toBe('auth');
    expect(key('source jira: jira search: no jira credential stored in the panel')).toBe('auth');
    expect(key('source jira: jira integration is off in the panel')).toBe('notConfigured');
    expect(key('source jira: panel state.json absent: jira is not configured')).toBe(
      'notConfigured',
    );
    expect(key('source jira: jira search: not-found (http 404)')).toBe('notFound');
    expect(key('source jira: jira search: rate-limited (http 429)')).toBe('rateLimited');
    expect(key('source jira: jira search: server-error (http 503)')).toBe('unreachable');
    expect(key('source jira: jira search: timeout')).toBe('unreachable');
    expect(key('source jira: read failed: socket hang up')).toBe('unreachable');
    expect(key('source jira: jira search: bad-response (http 200)')).toBe('badResponse');
    expect(searchProblemOf('source jira: a cause the panel never saw')).toEqual({
      key: 'generic',
      raw: 'source jira: a cause the panel never saw',
    });
  });

  it('outcome counts created and existing', () => {
    expect(outcomeOf({ created: ['a', 'b'], existing: ['c'], replayed: false })).toEqual({
      created: 2,
      existing: 1,
    });
  });
});
