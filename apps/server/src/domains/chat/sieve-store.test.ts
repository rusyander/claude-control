import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { LearnedSieveRow } from '@agentdeck/contracts/sieves';
import { SieveStore } from './sieve-store.ts';

/**
 * Выученные сита и счёт блокеров — на настоящем файле во временном каталоге
 * данных. Главное: сито из треда, который панель не пересылала, не проходит, а
 * один и тот же блокер не плодит сит.
 */

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function store(now = '2026-09-28T12:00:00Z'): { store: SieveStore; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'sieve-store-'));
  dirs.push(dir);
  return { store: new SieveStore(dir, () => new Date(now)), dir };
}

const MR = 'https://h/g/p/-/merge_requests/7';
const row = (over: Partial<LearnedSieveRow> = {}): LearnedSieveRow => ({
  thread: `${MR}#note_1`,
  class: 'contract',
  scope: 'project',
  trigger: 'a handler status code changes',
  check: 'curl the endpoint on the branch stand and compare with docs/api.md',
  ...over,
});

describe('выученные сита', () => {
  it('сито из пересланного треда принимается, из чужого — нет', () => {
    const { store: sieves } = store();
    const outcome = sieves.learn({
      rows: [
        row(),
        row({ thread: `${MR}#note_999`, check: 'invented check that never happened here' }),
      ],
      relayed: [`${MR}#note_1`],
      projectPath: '/p',
      mr: MR,
    });
    expect(outcome.accepted).toHaveLength(1);
    expect(outcome.rejected.map((item) => item.reason)).toEqual(['unknown-thread']);
    expect(sieves.list().learned[0]).toMatchObject({
      class: 'contract',
      scope: 'project',
      projectPath: '/p',
      sources: [{ thread: `${MR}#note_1`, mr: MR }],
    });
  });

  it('похожее сито того же класса не плодится — растёт число источников', () => {
    const { store: sieves } = store();
    sieves.learn({ rows: [row()], relayed: [`${MR}#note_1`], projectPath: '/p' });
    sieves.learn({
      rows: [
        row({
          thread: `${MR}#note_2`,
          check: 'compare docs/api.md with curl of the endpoint on the branch stand',
        }),
      ],
      relayed: [`${MR}#note_2`],
      projectPath: '/p',
    });
    const learned = sieves.list().learned;
    expect(learned).toHaveLength(1);
    expect(learned[0]?.sources.map((source) => source.thread)).toEqual([
      `${MR}#note_1`,
      `${MR}#note_2`,
    ]);
  });

  it('выученное сито — предложенное: в задания не идёт, пока человек не примет', () => {
    const { store: sieves } = store();
    sieves.learn({
      rows: [row({ scope: 'global' })],
      relayed: [`${MR}#note_1`],
      projectPath: '/p',
    });
    const [proposed] = sieves.list().learned;
    // Модель просила общее — это совет, охват остаётся проектом.
    expect(proposed).toMatchObject({
      status: 'proposed',
      scope: 'project',
      suggestedScope: 'global',
    });
    expect(sieves.forProject('/p')).toEqual([]);

    expect(sieves.accept(proposed?.id ?? '', 'project')).toBe(true);
    expect(sieves.forProject('/p')).toHaveLength(1);
    expect(sieves.forProject('/q')).toEqual([]);

    expect(sieves.accept(proposed?.id ?? '', 'global')).toBe(true);
    expect(sieves.list().learned[0]).toMatchObject({ status: 'active', scope: 'global' });
    expect(sieves.list().learned[0]?.projectPath).toBeUndefined();
    expect(sieves.forProject('/q')).toHaveLength(1);
    expect(sieves.accept('missing', 'global')).toBe(false);
  });

  it('тот же блокер в другом проекте советует сделать сито общим, но не делает', () => {
    const { store: sieves } = store();
    sieves.learn({ rows: [row()], relayed: [`${MR}#note_1`], projectPath: '/p' });
    sieves.accept(sieves.list().learned[0]?.id ?? '', 'project');
    sieves.learn({
      rows: [row({ thread: 'https://h/g/q/-/merge_requests/3#note_5' })],
      relayed: ['https://h/g/q/-/merge_requests/3#note_5'],
      projectPath: '/q',
    });
    expect(sieves.list().learned).toHaveLength(1);
    expect(sieves.list().learned[0]).toMatchObject({ scope: 'project', suggestedScope: 'global' });
    expect(sieves.forProject('/q')).toEqual([]);
  });

  it('тред сверяется точно: хвост или чужой адрес с тем же якорем — отказ', () => {
    const { store: sieves } = store();
    const outcome = sieves.learn({
      rows: [row({ thread: '1' }), row({ thread: 'https://evil.example/x#note_1' })],
      relayed: [`${MR}#note_1`],
      projectPath: '/p',
    });
    expect(outcome.rejected.map((item) => item.reason)).toEqual([
      'unknown-thread',
      'unknown-thread',
    ]);
    expect(sieves.list().learned).toEqual([]);
  });

  it('тот же тред в следующем обходе наблюдателя не считается вторым блокером', () => {
    const { store: sieves } = store();
    const input = { rows: [row()], relayed: [`${MR}#note_1`], projectPath: '/p' };
    sieves.learn(input);
    sieves.learn(input);
    expect(sieves.list().tally['2026-09']?.contract).toEqual({ escaped: 1, caught: 0 });
    expect(sieves.list().learned[0]?.sources).toHaveLength(1);
  });

  it('запись до статусов читается предложенной', () => {
    const { store: sieves, dir } = store();
    const legacy = { ...row(), id: 'old', sources: [], createdAt: 'x', lastSeenAt: 'x' };
    writeFileSync(
      join(dir, 'sieves.json'),
      JSON.stringify({ version: 1, learned: [legacy], tally: {} }),
    );
    expect(sieves.list().learned[0]?.status).toBe('proposed');
    expect(sieves.forProject('/p')).toEqual([]);
  });

  it('счёт: тред — один ушедший блокер, пойманное — отдельно, по месяцам', () => {
    const { store: sieves } = store();
    sieves.learn({
      rows: [row(), row({ check: 'also run the contract test through the real route here' })],
      relayed: [`${MR}#note_1`],
      projectPath: '/p',
    });
    sieves.caught(['integration', 'consumers']);
    expect(sieves.list().tally).toEqual({
      '2026-09': {
        contract: { escaped: 1, caught: 0 },
        integration: { escaped: 0, caught: 1 },
        consumers: { escaped: 0, caught: 1 },
      },
    });
  });

  it('человек убирает сито; битый файл не роняет панель', () => {
    const { store: sieves, dir } = store();
    sieves.learn({ rows: [row()], relayed: [`${MR}#note_1`], projectPath: '/p' });
    const id = sieves.list().learned[0]?.id ?? '';
    expect(sieves.remove(id)).toBe(true);
    expect(sieves.remove(id)).toBe(false);
    writeFileSync(join(dir, 'sieves.json'), '{broken');
    expect(sieves.list()).toEqual({ version: 1, learned: [], tally: {} });
    expect(readFileSync(join(dir, 'sieves.json'), 'utf8')).toBe('{broken');
  });
});
