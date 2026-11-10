import { describe, expect, it } from 'vitest';
import type { ConfigView } from '@agentdeck/contracts/core/config';
import { inboxSectionSchema, type InboxSection } from '@agentdeck/contracts/core/inbox';
import {
  draftOf,
  freeIdOf,
  listOf,
  newSourceDraft,
  pollChoices,
  reposOf,
  sectionOf,
  withInbox,
} from './inboxSources.lib';

const jiraSection: InboxSection = {
  pollMs: 900_000,
  sources: [
    {
      id: 'jira',
      system: 'jira',
      enabled: true,
      repos: { 'group/app': 'C:/work/app' },
      autoQueue: true,
      jira: { labels: ['qa-inbox'], assignedToMe: false, jql: 'project = PROJ' },
    },
  ],
};

describe('inbox sources window', () => {
  it('new source never queues by itself and takes a free name', () => {
    const draft = newSourceDraft('jira', ['jira', 'jira-2']);
    expect(draft.autoQueue).toBe(false);
    expect(draft.enabled).toBe(true);
    expect(draft.id).toBe('jira-3');
    expect(freeIdOf('gitlab', ['jira'])).toBe('gitlab');
  });

  it('a new source written to the section carries explicit autoQueue false', () => {
    const draft = draftOf(undefined);
    draft.sources.push({ ...newSourceDraft('jira', []), labels: 'qa-inbox, backend, qa-inbox' });
    const result = sectionOf(draft);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(inboxSectionSchema.safeParse(result.section).success).toBe(true);
    expect(result.section.sources[0]).toMatchObject({
      autoQueue: false,
      jira: { labels: ['qa-inbox', 'backend'], assignedToMe: false },
    });
    // Частота по умолчанию и ответ в тикет выключен — не пишутся: умолчание ядра.
    expect(result.section).not.toHaveProperty('pollMs');
    expect(result.section).not.toHaveProperty('commentBack');
  });

  it('round-trips an existing section through the draft unchanged', () => {
    const result = sectionOf(draftOf(jiraSection));
    expect(result).toEqual({ ok: true, section: jiraSection });
  });

  it('names every problem instead of writing: bad id, taken id, bad repo line, empty source', () => {
    const draft = draftOf(undefined);
    draft.sources.push(
      { ...newSourceDraft('jira', []), id: 'Jira Main', labels: 'a' },
      { ...newSourceDraft('jira', []), id: 'jira', labels: 'a', repos: 'no-equals-here' },
      { ...newSourceDraft('gitlab', []), id: 'jira' },
    );
    const result = sectionOf(draft);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.problems.map((p) => p.code)).toEqual(['id', 'repos', 'duplicate', 'empty']);
    expect(result.problems[0]?.values).toEqual({ id: 'Jira Main' });
  });

  it('gitlab source reads MR lists and keeps issues block', () => {
    const draft = draftOf(undefined);
    draft.sources.push({ ...newSourceDraft('gitlab', []), reviewerMrs: true });
    const result = sectionOf(draft);
    expect(result.ok && result.section.sources[0]).toMatchObject({
      system: 'gitlab',
      gitlab: { issues: { labels: [], assignedToMe: false }, reviewerMrs: true },
    });
  });

  it('parses lists and repo lines', () => {
    expect(listOf(' a, ,b ,a ')).toEqual(['a', 'b']);
    expect(reposOf('g/app = C:/x=y\n\n = C:/z')).toEqual({
      repos: { 'g/app': 'C:/x=y' },
      bad: ['= C:/z'],
    });
  });

  it('writes the whole doc from the view the window opened with, other sections kept', () => {
    const view = {
      doc: { v: 1, board: { inWork: 4 } },
      digest: 'd'.repeat(64),
      drift: null,
      issues: [],
    } as unknown as ConfigView;
    const { doc, baseDigest } = withInbox(view, jiraSection);
    expect(baseDigest).toBe('d'.repeat(64));
    expect(doc).toEqual({ v: 1, board: { inWork: 4 }, inbox: jiraSection });
  });

  it('poll choices keep a non-standard current value', () => {
    expect(pollChoices(5)).toEqual([1, 5, 15, 30, 60]);
    expect(pollChoices(7)).toEqual([1, 5, 7, 15, 30, 60]);
  });

  it('a value past the core schema is named in words of the window: field and limit, no zod prose', () => {
    const row = (patch: Partial<ReturnType<typeof newSourceDraft>>) => ({
      ...newSourceDraft('jira', []),
      assignedToMe: true,
      ...patch,
    });
    const long = sectionOf({
      sources: [row({ labels: 'x'.repeat(201) })],
      pollMinutes: 5,
      commentBack: false,
    });
    const many = sectionOf({
      sources: [row({ bugLabels: Array.from({ length: 51 }, (_, i) => `b${i}`).join(',') })],
      pollMinutes: 5,
      commentBack: false,
    });
    const repo = sectionOf({
      sources: [row({ repos: `group/app = ${'C:/'.repeat(400)}` })],
      pollMinutes: 5,
      commentBack: false,
    });
    expect(long.ok || long.problems).toEqual([
      { code: 'tooLong', values: { id: 'jira', field: 'labels', max: '200' } },
    ]);
    expect(many.ok || many.problems).toEqual([
      { code: 'tooMany', values: { id: 'jira', field: 'bugLabels', max: '50' } },
    ]);
    expect(repo.ok || repo.problems).toEqual([
      { code: 'tooLong', values: { id: 'jira', field: 'repos', max: '1000' } },
    ]);
  });
});
