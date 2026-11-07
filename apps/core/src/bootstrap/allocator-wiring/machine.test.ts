import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { LimitFact } from '@agentdeck/contracts/core/economy';
import type { TaskFoldState } from '../../journal/reduce/reduce.types.ts';
import { afterAll, describe, expect, it } from 'vitest';
import { WindowBook } from '../../economy/window/index.ts';
import { newId } from '../../lib/ids/uuidv7.ts';
import { CORE_HOME_ENV } from '../../platform/core-home.ts';
import { MACHINE_DIR_ENV, machineQueueDir, windowFactStore } from './machine.ts';
import { parallelismOf } from './planner.ts';

/**
 * Каталог машины и общие факты окна (этап 11, P141-P142): две книги окон на одном каталоге — как
 * два ядра машины; параллельность задачи — профиль, с которым её запустили, и потолок машины.
 */

const roots: string[] = [];
function temp(): string {
  const dir = join(tmpdir(), `mq-${newId().slice(-12)}`);
  mkdirSync(dir, { recursive: true });
  roots.push(dir);
  return dir;
}
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

const NOW = 5_000_000;
const fact = (over: Partial<LimitFact> = {}): LimitFact => ({
  routeId: 'cli-login:claude',
  limitKind: 'window',
  usedPct: 92,
  resetAt: NOW + 60_000,
  refusal: false,
  source: 'cli-event',
  at: NOW - 10,
  ...over,
});

describe('machine dir of the allocator', () => {
  const layout = { queue: '/home/core/queue' };

  it('named by AGENTDECK_CORE_MACHINE first; a moved core home keeps its own queue; else ~/.agentdeck/machine', () => {
    expect(machineQueueDir(layout, { [MACHINE_DIR_ENV]: '/m', [CORE_HOME_ENV]: '/h' }, '/u')).toBe(
      join('/m', 'queue'),
    );
    expect(machineQueueDir(layout, { [CORE_HOME_ENV]: '/h' }, '/u')).toBe('/home/core/queue');
    expect(machineQueueDir(layout, { [MACHINE_DIR_ENV]: '  ' }, '/u')).toBe(
      join('/u', '.agentdeck', 'machine', 'queue'),
    );
  });
});

describe('window facts shared by the cores of a machine (P142)', () => {
  it('a 92 % fact seen by core A holds work of core B on the same route; another route stays open', () => {
    const dir = temp();
    const a = new WindowBook(windowFactStore(dir));
    const b = new WindowBook(windowFactStore(dir));
    expect(b.decide('cli-login:claude', NOW)).toEqual([]);
    a.observe(fact());
    expect(b.decide('cli-login:claude', NOW).map((d) => d.verdict)).toEqual(['held']);
    expect(b.routes()).toEqual(['cli-login:claude']);
    expect(b.decide('local:own', NOW)).toEqual([]);
  });

  it('the latest fact of a pair wins across cores; an older late write does not overwrite the file', () => {
    const dir = temp();
    const store = windowFactStore(dir);
    const a = new WindowBook(store);
    const b = new WindowBook(windowFactStore(dir));
    b.observe(fact({ usedPct: 20, at: NOW - 5 }));
    a.observe(fact({ usedPct: 95, at: NOW - 50 }));
    expect(store.read()).toEqual([fact({ usedPct: 20, at: NOW - 5 })]);
    // Своя память A хранит свой (старый) факт, но суд берёт самый поздний по машине.
    expect(a.all()).toEqual([fact({ usedPct: 20, at: NOW - 5 })]);
    expect(a.decide('cli-login:claude', NOW).map((d) => d.verdict)).toEqual(['open']);
  });

  it('a garbage or foreign file in the store is skipped, the readable facts stay', () => {
    const dir = temp();
    const store = windowFactStore(dir);
    store.write(fact());
    writeFileSync(join(dir, 'window', 'bad.json'), '{not json');
    writeFileSync(join(dir, 'window', 'odd.json'), '{"routeId":1}');
    writeFileSync(join(dir, 'window', 'note.txt'), 'x');
    expect(store.read()).toEqual([fact()]);
    expect(windowFactStore(temp()).read()).toEqual([]);
  });
});

describe('parallelism of a task (P141)', () => {
  const stateOf = (profile?: 'economy' | 'balanced' | 'max-quality') =>
    ({
      created: {
        repos: [{ repoKey: 'r1', path: '/r', baseRef: 'main' }],
        ...(profile ? { lead: { profile } } : {}),
      },
    }) as unknown as TaskFoldState;

  it('the launch profile decides: balanced 4, max-quality 6, economy 2; sessionSlots caps it', () => {
    expect(parallelismOf(undefined, stateOf('balanced'), 6)).toBe(4);
    expect(parallelismOf(undefined, stateOf('max-quality'), 6)).toBe(6);
    expect(parallelismOf(undefined, stateOf('economy'), 6)).toBe(2);
    expect(parallelismOf(undefined, stateOf('max-quality'), 3)).toBe(3);
  });

  it('without a pinned profile the project setting rules; the pin overrides the project profile', () => {
    const section = { projects: { r1: { profile: 'max-quality' as const } } };
    expect(parallelismOf(section, stateOf(), 6)).toBe(6);
    expect(parallelismOf(section, stateOf('economy'), 6)).toBe(2);
    expect(parallelismOf(undefined, undefined, 6)).toBe(4);
  });
});
