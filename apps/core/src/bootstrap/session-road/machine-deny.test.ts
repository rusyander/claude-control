import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mapClaudePermission } from '../../adapters/claude/permission.ts';
import { answerHookCall } from '../../api/session-hook.ts';
import { seedSession } from '../../conductor/model-tools/__fixtures__/seed.ts';
import { bindingOf } from '../../conductor/model-tools/binding.ts';
import { CREATED, openFresh, tempDir } from '../../journal/__fixtures__/journal-harness.ts';
import { layoutOf } from '../../platform/core-home.ts';
import { MACHINE_DIR_ENV } from '../allocator-wiring/machine.ts';
import { createSessionRoad } from './road.ts';
import type { RoadStart } from './road.types.ts';

/**
 * Каталог машины (места сеансов, факты окна — `allocator-wiring/machine.ts`) лежит вне дома ядра,
 * но значит для очереди то же, что дом: подложенный факт окна «100 %» ставит отсрочку всей машине,
 * мусорное место останавливает выдачу, удалённое — отдаёт чужое место. Дорога сессии кладёт его в
 * запреты платформы — судья хука и оверлей CLI получают его вместе с домом ядра.
 */

afterEach(() => {
  vi.unstubAllEnvs();
});

async function stand() {
  const machine = tempDir('machine-');
  vi.stubEnv(MACHINE_DIR_ENV, machine);
  const home = tempDir('core-home-');
  const copy = tempDir('copy-');
  const { task } = await openFresh();
  task.append({ kind: 'task.created', actor: 'core', data: CREATED });
  const seeded = seedSession(task, { stepKind: 'work' });
  const bound = bindingOf(task, seeded.sessionId);
  if (!('binding' in bound)) throw new Error(bound.reason);
  const road = createSessionRoad({
    layout: layoutOf(home),
    adapters: { get: () => undefined },
  } as never);
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
  const allow = (tool: string, input: Record<string, unknown>) =>
    answerHookCall(
      task,
      bound.binding,
      { tool, input },
      {
        mapPermission: mapClaudePermission,
        context: road.contextFor(start),
      },
    ).allow;
  return { task, queue: join(machine, 'queue'), copy, allow };
}

describe('machine queue dir is a platform path of every session', () => {
  it('a model session can neither forge a window fact nor drop or delete a seat in the machine queue; its copy stays writable', async () => {
    const s = await stand();
    const fact = join(s.queue, 'window', 'x.json');
    const seat = join(s.queue, 'session', 'seats', 'x.json');
    expect(s.allow('Bash', { command: `echo {} > "${fact}"` })).toBe(false);
    expect(s.allow('Write', { file_path: seat, content: '{' })).toBe(false);
    expect(s.allow('Bash', { command: `rm -f "${seat}"` })).toBe(false);
    expect(s.allow('Write', { file_path: join(s.copy, 'src', 'a.ts'), content: '' })).toBe(true);
    s.task.close();
  });
});
