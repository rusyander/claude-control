import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { tempDir } from '../journal/__fixtures__/journal-harness.ts';
import { bootCore, type BootedCore } from './boot.ts';
import { checkOpenFiles } from './boot/open-files.ts';

/**
 * F15 (09 limits, 07:52): загрузка читает мягкий предел открытых файлов; ниже 4096 —
 * предупреждение в вывод ядра и строка `limits.open-files` в `core.jsonl`; нечитаемый предел и
 * Windows — тоже строка, без предупреждения.
 */

let core: BootedCore | undefined;
afterEach(async () => {
  await core?.stop();
  core = undefined;
});

const notesOf = (home: string) =>
  readFileSync(join(home, 'logs', 'core.jsonl'), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { event?: string; kind?: string; data?: unknown })
    .filter((row) => (row.event ?? row.kind) === 'limits.open-files');

describe('boot reads the open-files limit (F15)', () => {
  it('soft 256 → a warning line in the core output and a limits.open-files row with low:true', async () => {
    const home = join(tempDir('boot-files-'), 'core');
    const lines: string[] = [];
    core = await bootCore({
      home,
      build: 'open-files',
      log: (line) => lines.push(line),
      openFiles: async () => ({
        value: { soft: 256, hard: 'unlimited', low: true, source: 'launchctl' },
      }),
    });
    expect(lines.filter((line) => line.includes('open-files soft limit 256'))).toHaveLength(1);
    const rows = notesOf(core.layout.root);
    expect(rows).toHaveLength(1);
    expect(JSON.stringify(rows[0])).toContain('"low":true');
  }, 60_000);

  it('not applicable and unreadable are journaled without a warning; enough is journaled quietly', async () => {
    const notes: [string, Record<string, unknown>][] = [];
    const warns: string[] = [];
    const note = (event: string, data: Record<string, unknown>) => notes.push([event, data]);
    await checkOpenFiles(
      async () => ({ notApplicable: 'Windows' }),
      note,
      (l) => warns.push(l),
    );
    await checkOpenFiles(
      async () => ({ unknown: 'launchctl failed' }),
      note,
      (l) => warns.push(l),
    );
    await checkOpenFiles(
      async () => {
        throw new Error('boom');
      },
      note,
      (l) => warns.push(l),
    );
    await checkOpenFiles(
      async () => ({ value: { soft: 65536, hard: 65536, low: false, source: 'proc-self-limits' } }),
      note,
      (l) => warns.push(l),
    );
    expect(warns).toEqual([]);
    expect(notes).toEqual([
      ['limits.open-files', { notApplicable: 'Windows' }],
      ['limits.open-files', { unknown: 'launchctl failed' }],
      ['limits.open-files', { unknown: 'boom' }],
      ['limits.open-files', { soft: 65536, hard: 65536, low: false, source: 'proc-self-limits' }],
    ]);
  });
});
