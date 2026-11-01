import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { seedSession } from '../../conductor/model-tools/__fixtures__/seed.ts';
import { CREATED, openFresh, tempDir } from '../../journal/__fixtures__/journal-harness.ts';
import { readJournalLines } from '../../journal/read-lines.ts';
import type { LiveTask } from '../../journal/resume.ts';
import { layoutOf } from '../../platform/core-home.ts';
import { createSessionRoad } from './road.ts';
import type { RoadStart } from './road.types.ts';

/**
 * Сигналы области чтения настоящей дорогой сессии (F-87): `contextFor` читает `readAllow` конфига
 * ядра по исходному репозиторию. Раздел, не прошедший схему, — `read-allow-unread` (warn), список
 * пуст; запись списка, которую сборщик не принял, — `read-scope-refused` (info) с самой записью.
 * Обе — строки журнала задачи с шагом и сеансом; без них человек не видит, почему его путь закрыт.
 */

interface SignalData {
  signal: string;
  severity: string;
  subject: string;
  detail: string;
}

function signals(task: LiveTask, id: string) {
  return readJournalLines(task.dir, task.taskId)
    .lines.filter((l) => l.kind === 'signal' && (l.data as SignalData).signal === id)
    .map((l) => ({ stepId: l.stepId, sessionId: l.sessionId, ...(l.data as SignalData) }));
}

async function stand(readAllow: (source: string) => unknown) {
  const home = tempDir('core-home-');
  const layout = layoutOf(home);
  const source = tempDir('src-repo-');
  const copy = tempDir('copy-');
  writeFileSync(layout.config, JSON.stringify({ readAllow: readAllow(source) }));
  const { task } = await openFresh();
  task.append({
    kind: 'task.created',
    actor: 'core',
    data: { ...CREATED, repos: [{ repoKey: 'r1', path: source, baseRef: 'main' }] },
  });
  const seeded = seedSession(task, { stepKind: 'work' });
  const road = createSessionRoad({ layout, adapters: { get: () => undefined } } as never);
  const start = {
    task,
    stepId: seeded.stepId,
    sessionId: seeded.sessionId,
    adapterId: 'claude',
    cwd: copy,
    dir: join(home, 'sessions', seeded.sessionId),
    deny: { paths: [], commands: [], mcpTools: [], tools: [] },
    layer: { hooks: 'on', skills: 'on' },
    model: null,
    pin: {},
  } as unknown as RoadStart;
  return { task, road, start, layout, source, copy, seeded };
}

describe('read scope signals through the real session road', () => {
  it('read-allow-unread: a readAllow section that fails the schema is a warn signal naming the config, and the list stays empty', async () => {
    const s = await stand((source) => ({ [source]: 'not-a-list' }));
    const ctx = s.road.contextFor(s.start);
    expect(ctx.readScope?.human ?? []).toEqual([]);
    const got = signals(s.task, 'read-allow-unread');
    expect(got).toHaveLength(1);
    expect(got[0]).toMatchObject({
      severity: 'warn',
      subject: s.layout.config,
      stepId: s.seeded.stepId,
      sessionId: s.seeded.sessionId,
    });
    expect(got[0]?.detail).toMatch(/readAllow/);
    expect(signals(s.task, 'read-scope-refused')).toEqual([]);
    s.task.close();
  });

  it('read-scope-refused: an entry the builder cannot accept is an info signal naming it; the accepted entries stay', async () => {
    const shared = tempDir('shared-');
    const s = await stand((source) => ({ [source]: [shared, ''] }));
    const ctx = s.road.contextFor(s.start);
    expect(ctx.readScope?.human).toEqual([shared]);
    const got = signals(s.task, 'read-scope-refused');
    expect(got).toEqual([
      {
        stepId: s.seeded.stepId,
        sessionId: s.seeded.sessionId,
        signal: 'read-scope-refused',
        severity: 'info',
        subject: '',
        detail: 'empty entry',
      },
    ]);
    expect(signals(s.task, 'read-allow-unread')).toEqual([]);
    s.task.close();
  });

  it('near-miss: a well-formed readAllow of absolute paths writes neither signal', async () => {
    const shared = tempDir('shared-');
    const s = await stand((source) => ({ [source]: [shared] }));
    expect(s.road.contextFor(s.start).readScope?.human).toEqual([shared]);
    expect(signals(s.task, 'read-allow-unread')).toEqual([]);
    expect(signals(s.task, 'read-scope-refused')).toEqual([]);
    s.task.close();
  });
});
