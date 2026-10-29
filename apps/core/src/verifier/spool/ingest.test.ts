import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SpoolRecord } from '@agentdeck/contracts/core/records';
import { afterAll, describe, expect, it } from 'vitest';
import { ingestSpool, SPOOL_BAD_DIR, type SpoolSink } from './ingest.ts';

/**
 * Забор очереди `spool/` (04:36, G22, P44): файл снимается только после того, как хранилище
 * его взяло; чужая форма — в `bad/`, не удалена; непрочитанный каталог — `unread`, не «пусто».
 */

const root = mkdtempSync(join(tmpdir(), 'spool-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const record = (n: number): SpoolRecord => ({
  v: 1,
  spoolId: `1000-42-${n}`,
  at: 1,
  road: 'node-preload',
  argv: ['node', 'vitest.mjs'],
  cwd: '/p',
  tree: 'd'.repeat(40),
  envDigest: 'c'.repeat(64),
  envNames: ['CI', 'NODE_ENV', 'TZ'],
  exit: 0,
  ms: 3,
  log: `run ${n}`,
  truncated: false,
  token: 'session',
});

function spoolDir(name: string, files: Record<string, string>): string {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  for (const [file, text] of Object.entries(files)) writeFileSync(join(dir, file), text);
  return dir;
}

function sink(refuse = false): SpoolSink & { took: SpoolRecord[] } {
  const took: SpoolRecord[] = [];
  return {
    took,
    async take(r) {
      if (refuse) return { refused: 'store down' };
      took.push(r);
      return { taken: `rec-${took.length}` };
    },
  };
}

describe('spool ingest', () => {
  it('taken files are removed; a half-written .tmp is left for its writer; order by name', async () => {
    const dir = spoolDir('ok', {
      '1000-42-2.json': JSON.stringify(record(2)),
      '1000-42-1.json': JSON.stringify(record(1)),
      '1000-42-3.json.77.tmp': '{"v":1',
    });
    const s = sink();
    const out = await ingestSpool(dir, s);
    expect(out).toEqual({ taken: ['rec-1', 'rec-2'], bad: [], kept: [] });
    expect(s.took.map((r) => r.log)).toEqual(['run 1', 'run 2']);
    expect(readdirSync(dir)).toEqual(['1000-42-3.json.77.tmp']);
  });

  it('store refusal keeps the file with the reason', async () => {
    const dir = spoolDir('refused', { '1000-42-1.json': JSON.stringify(record(1)) });
    const out = await ingestSpool(dir, sink(true));
    expect(out.taken).toEqual([]);
    expect(out.kept).toEqual([
      { file: join(dir, '1000-42-1.json'), reason: 'store refused: store down' },
    ]);
    expect(existsSync(join(dir, '1000-42-1.json'))).toBe(true);
  });

  it('not JSON or a foreign shape → moved to bad/, never fed to the store, never deleted', async () => {
    const dir = spoolDir('bad', {
      '1-1-1.json': '{broken',
      '1-1-2.json': JSON.stringify({ ...record(2), extra: 'x' }),
      '1-1-3.json': JSON.stringify({ ...record(3), token: 'core' }),
    });
    const s = sink();
    const out = await ingestSpool(dir, s);
    expect(s.took).toEqual([]);
    expect(out.bad.map((b) => b.file)).toEqual([
      join(dir, '1-1-1.json'),
      join(dir, '1-1-2.json'),
      join(dir, '1-1-3.json'),
    ]);
    expect(out.bad[0]!.reason).toMatch(/^not JSON/);
    expect(out.bad[1]!.reason).toMatch(/^wrong form/);
    expect(readdirSync(join(dir, SPOOL_BAD_DIR)).sort()).toEqual([
      '1-1-1.json',
      '1-1-2.json',
      '1-1-3.json',
    ]);
  });

  it('A2-F05: a road no shim produces (container-wrapper) is a foreign shape → bad/', async () => {
    const dir = spoolDir('dead-road', {
      '1-1-9.json': JSON.stringify({ ...record(9), road: 'container-wrapper' }),
    });
    const s = sink();
    const out = await ingestSpool(dir, s);
    expect(s.took).toEqual([]);
    expect(out.bad.map((b) => b.reason)).toEqual([expect.stringMatching(/^wrong form/)]);
  });

  it('B2-F01: a file without the spool-time tree identity or the env names (older shim) → bad/, never keyed to the drain-time tree', async () => {
    const { tree: _tree, ...noTree } = record(1);
    const { envNames: _names, ...noNames } = record(2);
    void _tree;
    void _names;
    const dir = spoolDir('no-identity', {
      '1-1-1.json': JSON.stringify(noTree),
      '1-1-2.json': JSON.stringify(noNames),
    });
    const s = sink();
    const out = await ingestSpool(dir, s);
    expect(s.took).toEqual([]);
    expect(out.bad).toHaveLength(2);
  });

  it('absent spool dir → nothing, not unread', async () => {
    expect(await ingestSpool(join(root, 'none'), sink())).toEqual({
      taken: [],
      bad: [],
      kept: [],
    });
  });

  it('P44: an unread spool dir is unknown, never «empty»; an unread file is kept with its reason', async () => {
    const blind = await ingestSpool(join(root, 'x'), sink(), {
      list: () => ({ unknown: 'EACCES' }),
    });
    expect(blind.unread).toMatch(/EACCES/);
    expect(blind.taken).toEqual([]);
    const dir = spoolDir('unread-file', { '1000-42-1.json': JSON.stringify(record(1)) });
    const out = await ingestSpool(dir, sink(), { read: () => ({ unknown: 'EBUSY' }) });
    expect(out.kept).toEqual([{ file: join(dir, '1000-42-1.json'), reason: 'unread: EBUSY' }]);
    expect(existsSync(join(dir, '1000-42-1.json'))).toBe(true);
  });
});
