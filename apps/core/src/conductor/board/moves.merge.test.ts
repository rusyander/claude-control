import { boardEntrySchema, type BoardEntry } from '@agentdeck/contracts/core/board';
import { INTAKE_SOURCES_MAX } from '@agentdeck/contracts/core/intake';
import { describe, expect, it } from 'vitest';
import { newId } from '../../lib/ids/uuidv7.ts';
import { allowedMoves, applyMove } from './moves.ts';
import type { BoardFile } from './store.types.ts';

/**
 * Ход человека `merge` (этап 12, B11, D26, P186) на копии файла доски: одна запись несёт источники
 * и снимки всех тикетов, сложенные уходят; вне «Входящих», MR-запись, запись без снимка тикета,
 * перебор снимков одной оценки и неизвестная запись — отказ, файл не тронут.
 */

const DIGEST = 'a'.repeat(64);
function ticket(key: string, over: Partial<BoardEntry> = {}): BoardEntry {
  return {
    entryId: newId(),
    state: 'inbox',
    rank: 0,
    stop: 'mr',
    preset: 'tracker-ticket',
    source: {
      kind: 'tracker',
      system: 'jira-main',
      key,
      url: `https://tracker.example.com/browse/${key}`,
      title: key,
    },
    launch: {
      kind: 'fields',
      fields: {
        title: key,
        request: `${key} body`,
        repos: [{ path: `C:/repos/${key.startsWith('OPS') ? 'ops' : 'app'}`, baseRef: null }],
        source: {
          kind: 'tracker',
          key,
          title: key,
          body: `${key} body`,
          fetchedAt: 1,
          digest: DIGEST,
        },
      },
    },
    digest: DIGEST,
    related: { links: [], paths: [`src/${key}.ts`] },
    createdAt: 1,
    ...over,
  };
}
const fileOf = (...entries: BoardEntry[]): BoardFile => ({ v: 1, entries, moves: [] });
const merge = (entryId: string, entryIds: string[]) => ({
  cmdId: newId(),
  entryId,
  to: 'merge' as const,
  entryIds,
});

describe('board move merge, stage 12 (B11, P186)', () => {
  it('folds two inbox entries into the target: 3 sources, 3 snapshots, repos and related united, 2 gone', () => {
    const a = ticket('PROJ-1');
    const b = ticket('PROJ-2', {
      merged: [{ kind: 'tracker', system: 'jira-main', key: 'PROJ-9', title: 'earlier fold' }],
    });
    const c = ticket('OPS-3');
    const file = fileOf(a, b, c);
    expect(allowedMoves(a)).toContain('merge');
    expect(applyMove(file, merge(a.entryId, [b.entryId, c.entryId]), 5)).toEqual({ ok: true });
    expect(file.entries.map((e) => e.entryId)).toEqual([a.entryId]);
    const kept = file.entries[0]!;
    expect([kept.source, ...(kept.merged ?? [])].map((s) => s.key)).toEqual([
      'PROJ-1',
      'PROJ-2',
      'PROJ-9',
      'OPS-3',
    ]);
    const fields = kept.launch.kind === 'fields' ? kept.launch.fields : {};
    expect(fields.source).toBeUndefined();
    expect((fields.sources as { key: string }[]).map((s) => s.key)).toEqual([
      'PROJ-1',
      'PROJ-2',
      'OPS-3',
    ]);
    expect(fields.repos).toEqual([
      { path: 'C:/repos/app', baseRef: null },
      { path: 'C:/repos/ops', baseRef: null },
    ]);
    expect(kept.related?.paths).toEqual(['src/PROJ-1.ts', 'src/PROJ-2.ts', 'src/OPS-3.ts']);
    // Запись остаётся во «Входящих» без доказательства: старт — следующим ходом человека.
    expect(kept.state).toBe('inbox');
    expect(kept.proof).toBeUndefined();
    expect(boardEntrySchema.safeParse(kept).success).toBe(true);
  });

  it('refuses outside the inbox, an MR entry, an entry without a ticket snapshot, an unknown entry; the file is untouched', () => {
    const a = ticket('PROJ-1');
    const queued = ticket('PROJ-2', {
      state: 'queued',
      proof: { kind: 'human', cmdId: newId(), at: 1 },
    });
    const mr: BoardEntry = {
      ...ticket('PROJ-3'),
      preset: 'review-link',
      source: { kind: 'forge', system: 'gl', key: 'grp/app!7', title: 'MR 7' },
      launch: { kind: 'link', mrUrl: 'https://forge.example.com/grp/app/-/merge_requests/7' },
    };
    const hand: BoardEntry = {
      ...ticket('PROJ-4'),
      source: { kind: 'telegram', key: 'tg:1:2', title: 'by hand' },
      launch: { kind: 'fields', fields: { title: 'by hand', request: 'do it' } },
    };
    const file = fileOf(a, queued, mr, hand);
    const before = structuredClone(file);
    const cases: [ReturnType<typeof merge>, number, RegExp][] = [
      [merge(queued.entryId, [a.entryId]), 409, /not allowed from queued/],
      [merge(a.entryId, [queued.entryId]), 409, /is queued: only inbox entries merge/],
      [merge(a.entryId, [mr.entryId]), 409, /MR entry does not merge/],
      [merge(mr.entryId, [a.entryId]), 409, /MR entry does not merge/],
      [merge(a.entryId, [hand.entryId]), 409, /no ticket snapshot/],
      [merge(a.entryId, [newId()]), 404, /no board entry/],
    ];
    for (const [move, status, reason] of cases) {
      const got = applyMove(file, move, 5);
      expect(got.ok).toBe(false);
      if (got.ok) continue;
      expect(got.status).toBe(status);
      expect(got.reason).toMatch(reason);
    }
    expect(file).toEqual(before);
  });

  it('refuses a merge carrying more ticket snapshots than one estimate takes', () => {
    const many = Array.from({ length: INTAKE_SOURCES_MAX }, (_, i) => ticket(`PROJ-${i + 10}`));
    const target = ticket('PROJ-1');
    const file = fileOf(target, ...many);
    const got = applyMove(
      file,
      merge(
        target.entryId,
        many.map((e) => e.entryId),
      ),
      5,
    );
    expect(got).toMatchObject({ ok: false, status: 409 });
    expect(file.entries).toHaveLength(INTAKE_SOURCES_MAX + 1);
    const fits = applyMove(
      file,
      merge(
        target.entryId,
        many.slice(1).map((e) => e.entryId),
      ),
      5,
    );
    expect(fits).toEqual({ ok: true });
  });
});
