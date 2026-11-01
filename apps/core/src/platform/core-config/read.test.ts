import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { QUEUE_LIMITS, type ConfigView } from '@agentdeck/contracts/core/config';
import { describe, expect, it } from 'vitest';
import { tempDir } from '../../journal/__fixtures__/journal-harness.ts';
import { MIN_BEAT_MS } from '../../verifier/queue/order.ts';
import { layoutOf } from '../core-home.ts';
import { parseCoreConfig, queueRejected, readCoreConfig, sectionProblem } from './read.ts';

/**
 * Единый читатель `config.json` (этап 7) судит каждый раздел схемой из контрактов. Пять прежних
 * разборщиков удалены (их читатели ходят сюда); таблица держит вердикт «принят / отказ» каждой
 * схемы на тех же документах, на которых его держали прежние разборщики. Два раздела спасаются
 * по частям, как судили прежние: `grantRequired` по строкам, `queue` по полям. Намеренные
 * расхождения названы: `queue` списком прежний разборщик принимал случайно, схема — нет;
 * `readAllow` с кривым списком ЛЮБОГО репозитория не действует целиком (прежний смотрел только
 * свой) — область сужается.
 */

const REPO = '/repo';
const OWN = {
  server: { command: 'llama-server' },
  models: [{ id: 'm', path: '/m', sizeBytes: 1 }],
};

const CASES: [section: string, value: unknown, accepted: boolean][] = [
  ['routes', { stub: [{ name: 's', script: [] }] }, true],
  ['routes', { stub: [{ name: 's', script: { module: 'm', export: 'e' }, models: ['a'] }] }, true],
  ['routes', { localOwn: OWN, extra: 1 }, true],
  ['routes', { stub: [{ name: '  ', script: [] }] }, false],
  ['routes', { stub: [{ name: 's', script: 'x' }] }, false],
  ['routes', { localOwn: { ...OWN, models: [] } }, false],
  ['routes', { localOwn: { ...OWN, models: [{ id: 'm', path: '/m', sizeBytes: 0 }] } }, false],
  ['routes', [], false],
  ['readAllow', { [REPO]: ['a', ''] }, true],
  ['readAllow', { [REPO]: ['a', 1] }, false],
  ['readAllow', { [REPO]: 'a' }, false],
  ['readAllow', ['a'], false],
  ['grantRequired', [{ project: REPO, globs: ['a/**'], ops: ['edit', 'exec-db'] }], true],
  ['grantRequired', [{ project: REPO, globs: [], ops: ['edit'] }], false],
  ['grantRequired', [{ project: REPO, globs: ['a'], ops: ['push'] }], false],
  ['grantRequired', [{ project: REPO, globs: [''], ops: ['edit'] }], false],
  ['grantRequired', { project: REPO }, false],
  ['forgePoll', [REPO], true],
  ['forgePoll', [''], false],
  ['forgePoll', REPO, false],
  ['queue', { slots: 2, shareCap: 1, agingMs: 0.5 * 3_600_000, beatMs: MIN_BEAT_MS }, true],
  ['queue', { beatMs: MIN_BEAT_MS - 1 }, false],
  ['queue', { slots: 1.5 }, false],
  ['queue', { shareCap: 2 }, false],
  ['queue', { slots: 0 }, false],
  ['queue', 'x', false],
  ['queue', [], false],
  [
    'humanPoints',
    { actionClasses: [], pathGlobs: ['.claude/**'], trackerWrites: 'ask', forgeWrites: 'ask' },
    true,
  ],
  [
    'humanPoints',
    { actionClasses: [], pathGlobs: [], trackerWrites: 'never', forgeWrites: 'ask' },
    false,
  ],
  ['trustedRepos', [REPO], true],
  ['trustedRepos', [''], false],
];

function view(text: string): ConfigView {
  const read = parseCoreConfig(text);
  if (!('value' in read)) throw new Error('not read');
  return read.value;
}

describe('core config single reader', () => {
  it.each(CASES)(
    'section %s %j: the contract schema accepts it = %s, a refusal is named',
    (section, value, accepted) => {
      const read = view(JSON.stringify({ [section]: value }));
      expect(read.issues.length === 0).toBe(accepted);
      expect(sectionProblem(read, section as never) === undefined).toBe(accepted);
    },
  );

  it('grantRequired is salvaged by row: good rows stay in force, each bad row is named by index', () => {
    const good = { project: REPO, globs: ['migrations/**'], ops: ['edit'] };
    const read = view(
      JSON.stringify({ grantRequired: [good, { project: REPO, globs: [], ops: ['edit'] }, good] }),
    );
    expect(read.doc.grantRequired).toEqual([good, good]);
    expect(read.issues).toEqual([
      { section: 'grantRequired', reason: expect.stringMatching(/^1: globs/) },
    ]);
  });

  it('queue is salvaged by field: good fields stay, a bad field is named, a non-object is rejected whole', () => {
    const read = view(JSON.stringify({ queue: { slots: 3, shareCap: 2 } }));
    expect(read.doc.queue).toEqual({ slots: 3 });
    expect(read.issues).toEqual([{ section: 'queue', reason: 'shareCap: 2 rejected' }]);
    expect(queueRejected(read)).toEqual(new Set(['shareCap']));
    expect(queueRejected(view('{"queue":[]}'))).toBe('all');
    expect('queue' in view('{"queue":[]}').doc).toBe(false);
  });

  it('the queue beat floor in contracts is the floor the queue beats at', () => {
    expect(QUEUE_LIMITS.beatMs.min).toBe(MIN_BEAT_MS);
  });

  it('a bad section is named and dropped, good ones stay; an unknown key and version are issues', () => {
    const read = view(JSON.stringify({ v: 2, forgePoll: [REPO], readAllow: [], extra: true }));
    expect(read.doc).toEqual({ forgePoll: [REPO] });
    expect(read.issues.map((i) => i.section).sort()).toEqual(['extra', 'readAllow', 'v']);
    expect(read.digest).toMatch(/^[0-9a-f]{64}$/);
    expect(read.drift).toBeNull();
    expect(parseCoreConfig('[]')).toEqual({ unknown: 'config.json: not an object' });
    expect('unknown' in parseCoreConfig('{')).toBe(true);
  });

  it('a routes refusal names every bad field, not only the first', () => {
    const read = view(JSON.stringify({ routes: { localOwn: { models: [] } } }));
    expect(sectionProblem(read, 'routes')).toMatch(
      /^routes: localOwn\.server: .*; localOwn\.models: /,
    );
  });

  it('reads the home file: absent when missing, the parsed view when present', () => {
    const layout = layoutOf(tempDir('core-config-'));
    mkdirSync(layout.root, { recursive: true });
    expect(readCoreConfig(layout)).toEqual({ absent: true });
    writeFileSync(join(layout.config), JSON.stringify({ v: 1, forgePoll: [REPO] }));
    const read = readCoreConfig(layout);
    expect('value' in read && read.value.doc).toEqual({ v: 1, forgePoll: [REPO] });
  });
});
