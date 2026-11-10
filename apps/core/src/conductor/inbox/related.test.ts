import type { BoardEntry, BoardRelated, BoardReply } from '@agentdeck/contracts/core/board';
import { describe, expect, it } from 'vitest';
import {
  mergedRelated,
  normalPath,
  relatedHintsOf,
  relatedReasons,
  withRelatedHints,
} from './related.ts';

/**
 * Подсказки «связано с …» (этап 12, B11, D26, P186) — таблица чистой функции: общий эпик, связь
 * задач, путь в обоих тикетах — подсказка; общая метка, система, похожий заголовок — нет.
 */

let n = 0;
function entry(key: string, related?: BoardRelated, over: Partial<BoardEntry> = {}): BoardEntry {
  n += 1;
  return {
    entryId: `01900000-0000-7000-8000-${String(n).padStart(12, '0')}`,
    state: 'inbox',
    rank: n,
    stop: 'mr',
    preset: 'tracker-ticket',
    source: { kind: 'tracker', system: 'jira-main', key, title: `${key} title` },
    launch: { kind: 'fields', fields: { title: key, request: key } },
    createdAt: 1,
    ...(related ? { related } : {}),
    ...over,
  };
}
const rel = (o: Partial<BoardRelated> = {}): BoardRelated => ({ links: [], paths: [], ...o });

describe('merge hints, stage 12: a pure function of epic, links and paths (P186)', () => {
  it.each([
    ['shared epic', rel({ epic: 'PROJ-1' }), rel({ epic: 'PROJ-1' }), ['epic']],
    ['one is the parent of the other', rel({ epic: 'PROJ-2' }), rel(), ['epic']],
    ['an issue link a → b', rel({ links: ['PROJ-2'] }), rel(), ['link']],
    ['an issue link b → a', rel(), rel({ links: ['PROJ-1'] }), ['link']],
    [
      'a path named in both',
      rel({ paths: ['src/a/b.ts'] }),
      rel({ paths: ['./src/a/b.ts'] }),
      ['path'],
    ],
    [
      'backslash path form',
      rel({ paths: ['src\\a\\b.ts'] }),
      rel({ paths: ['src/a/b.ts'] }),
      ['path'],
    ],
    [
      'all three at once, contract order',
      rel({ epic: 'PROJ-9', paths: ['x/y.ts'] }),
      rel({ epic: 'PROJ-9', links: ['PROJ-1'], paths: ['x/y.ts'] }),
      ['epic', 'link', 'path'],
    ],
    ['different epics', rel({ epic: 'PROJ-8' }), rel({ epic: 'PROJ-9' }), []],
    ['both without an epic', rel(), rel(), []],
    ['a link to a third ticket', rel({ links: ['PROJ-3'] }), rel({ links: ['PROJ-3'] }), []],
    ['different paths', rel({ paths: ['src/a.ts'] }), rel({ paths: ['src/b.ts'] }), []],
    ['no related facts at all', undefined, undefined, []],
  ] as const)('%s', (_name, a, b, reasons) => {
    const x = entry('PROJ-1', a as BoardRelated | undefined);
    const y = entry('PROJ-2', b as BoardRelated | undefined);
    expect(relatedReasons(x, y)).toEqual(reasons);
    expect(relatedReasons(y, x)).toEqual(reasons);
  });

  it('a shared label, system and look-alike title give no hint (labels are not related facts)', () => {
    const x = entry('PROJ-1', rel(), {
      source: { kind: 'tracker', system: 'jira-main', key: 'PROJ-1', title: 'Login fails' },
    });
    const y = entry('PROJ-2', rel(), {
      source: { kind: 'tracker', system: 'jira-main', key: 'PROJ-2', title: 'Login fails' },
    });
    expect(relatedReasons(x, y)).toEqual([]);
    expect(relatedHintsOf([x, y]).size).toBe(0);
  });

  it('a ticket folded into an entry counts as that entry for links and parents', () => {
    const host = entry('PROJ-1', rel(), {
      merged: [{ kind: 'tracker', system: 'jira-main', key: 'PROJ-5', title: 'folded' }],
    });
    expect(relatedReasons(host, entry('PROJ-2', rel({ links: ['PROJ-5'] })))).toEqual(['link']);
    expect(relatedReasons(host, entry('PROJ-3', rel({ epic: 'PROJ-5' })))).toEqual(['epic']);
  });

  it('hints link inbox entries only, in column order; queued and rejected entries neither get nor give one', () => {
    const a = entry('PROJ-1', rel({ epic: 'E-1' }));
    const b = entry('PROJ-2', rel({ epic: 'E-1' }));
    const c = entry('PROJ-3', rel({ epic: 'E-1' }), { rank: -5 });
    const queued = entry('PROJ-4', rel({ epic: 'E-1' }), { state: 'queued' });
    const rejected = entry('PROJ-6', rel({ epic: 'E-1' }), { state: 'rejected' });
    const hints = relatedHintsOf([a, b, c, queued, rejected]);
    expect(hints.get(a.entryId)?.map((h) => h.entryId)).toEqual([c.entryId, b.entryId]);
    expect(hints.get(a.entryId)?.[0]).toEqual({
      entryId: c.entryId,
      title: 'PROJ-3 title',
      reasons: ['epic'],
    });
    expect(hints.has(queued.entryId)).toBe(false);
    expect(hints.has(rejected.entryId)).toBe(false);
  });

  it('withRelatedHints sets related on inbox entry cards only and leaves a hintless reply as is', () => {
    const a = entry('PROJ-1', rel({ links: ['PROJ-2'] }));
    const b = entry('PROJ-2', rel());
    const card = (e: BoardEntry) => ({
      kind: 'entry' as const,
      id: e.entryId,
      entryId: e.entryId,
      column: 'inbox' as const,
      title: e.source.title,
      stop: 'mr' as const,
      waiting: false,
      questions: 0,
      takeover: null,
      moves: [],
      createdAt: 1,
    });
    const reply = { cards: [card(a), card(b)], entries: [a, b] } as unknown as BoardReply;
    const out = withRelatedHints(reply);
    expect(out.cards[0]?.related).toEqual([
      { entryId: b.entryId, title: 'PROJ-2 title', reasons: ['link'] },
    ]);
    expect(out.cards[1]?.related?.[0]?.entryId).toBe(a.entryId);
    const lone = { cards: [card(b)], entries: [b] } as unknown as BoardReply;
    expect(withRelatedHints(lone)).toBe(lone);
  });

  it('mergedRelated unions links and paths, drops links to tickets now inside the entry, keeps the first outside epic', () => {
    const target = entry('PROJ-1', rel({ links: ['PROJ-2', 'PROJ-7'], paths: ['a/b.ts'] }));
    const folded = entry(
      'PROJ-2',
      rel({ epic: 'PROJ-1', links: ['PROJ-8'], paths: ['a/b.ts', 'c/d.ts'] }),
    );
    const third = entry('PROJ-3', rel({ epic: 'E-9' }));
    expect(mergedRelated(target, [folded, third])).toEqual({
      epic: 'E-9',
      links: ['PROJ-7', 'PROJ-8'],
      paths: ['a/b.ts', 'c/d.ts'],
    });
    expect(mergedRelated(entry('PROJ-4'), [entry('PROJ-5')])).toBeUndefined();
  });

  it('normalPath unifies slashes and drops a leading ./', () => {
    expect(normalPath(' .\\src\\x.ts ')).toBe('src/x.ts');
    expect(normalPath('././a/b.md')).toBe('a/b.md');
  });
});
