import { boardEntrySchema } from '@agentdeck/contracts/core/board';
import type { InboxSource } from '@agentdeck/contracts/core/inbox';
import type { TrackerIssue } from '@agentdeck/trackers/jira.types';
import { describe, expect, it } from 'vitest';
import { newId } from '../../lib/ids/uuidv7.ts';
import type { BoardFile } from '../board/store.types.ts';
import { applyIntake, withDigest } from './dedupe.ts';
import { draftOf } from './kind.ts';
import { jiraRead } from './poller.ts';

/**
 * Шов волны 3 (этап 12, D26, P186) в дедупликации входящих: запись хранит факты связей тикета
 * (`related`) для подсказки «связано с …», а источники, сложенные в неё ходом `merge`
 * (`merged`), держат свои ключи — опрос не заводит слитый тикет заново.
 */

const JIRA: Extract<InboxSource, { system: 'jira' }> = {
  id: 'jira-main',
  system: 'jira',
  enabled: true,
  repos: { PROJ: 'C:/repos/app' },
  jira: { labels: ['agent'], assignedToMe: false },
};

const issue = (over: Partial<TrackerIssue> = {}): TrackerIssue => ({
  key: 'PROJ-1',
  summary: 'Add export button',
  status: 'To Do',
  type: 'Story',
  url: 'https://tracker.example.com/browse/PROJ-1',
  description: 'Export the list as CSV; see src/list/export.ts',
  labels: ['agent'],
  priority: 'Medium',
  parent: { key: 'PROJ-100' },
  links: [{ key: 'PROJ-7', direction: 'outward' }],
  ...over,
});

const draft = (over: Partial<TrackerIssue> = {}, at = 1) =>
  withDigest(draftOf(JIRA, jiraRead(JIRA, issue(over))!, at));
const emptyFile = (): BoardFile => ({ v: 1, entries: [], moves: [] });
const ctx = { at: 1, stop: 'mr' as const, newId, queueBy: null };

describe('inbox dedupe, stage 12: related facts and merged sources', () => {
  it('a new entry stores the ticket related facts and stays schema-valid', () => {
    const file = emptyFile();
    const d = draft();
    applyIntake(file, [d], ctx);
    const entry = file.entries[0]!;
    expect(d.related).toMatchObject({ epic: 'PROJ-100' });
    expect(entry.related).toEqual(d.related);
    expect(entry.related?.links).toContain('PROJ-7');
    expect(boardEntrySchema.safeParse(entry).success).toBe(true);
  });

  it('a merged source keeps its key: the poll does not recreate the folded ticket', () => {
    const file = emptyFile();
    applyIntake(file, [draft(), draft({ key: 'PROJ-2' })], ctx);
    const [kept, folded] = file.entries as [(typeof file.entries)[0], (typeof file.entries)[0]];
    // Ход `merge` (зона доски): источник сложенной записи остаётся на выжившей, сама запись уходит.
    kept.merged = [folded.source];
    file.entries.splice(1, 1);
    const again = applyIntake(file, [draft({ key: 'PROJ-2' })], ctx);
    expect(again.created).toEqual([]);
    expect(again.existing).toEqual([kept.entryId]);
    expect(file.entries).toHaveLength(1);
    expect(boardEntrySchema.safeParse(kept).success).toBe(true);
  });

  it('a changed ticket refreshes related on an inbox entry', () => {
    const file = emptyFile();
    applyIntake(file, [draft()], ctx);
    const moved = draft({ summary: 'Changed', links: [{ key: 'PROJ-9', direction: 'inward' }] }, 2);
    expect(applyIntake(file, [moved], ctx).marked).toHaveLength(1);
    expect(file.entries[0]!.related?.links).toContain('PROJ-9');
  });
});
