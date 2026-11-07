import { afterEach, describe, expect, it } from 'vitest';
import type { AdapterRegistry, CliAdapter } from '../../adapters/index.ts';
import type { XlPort } from '../../conductor/run/run.types.ts';
import type { SeatAnswer, SeatAsk, SeatPort } from '../../conductor/schedule/index.ts';
import { writeLibraryScenario } from '../../conductor/scenario/index.ts';
import { createTaskRegistry, type TaskRegistry } from '../../conductor/tasks.ts';
import {
  CREATED,
  deps,
  MINI_SCENARIO,
  tempDir,
} from '../../journal/__fixtures__/journal-harness.ts';
import type { LiveTask } from '../../journal/resume.ts';
import type { SessionRoad } from '../session-road.ts';
import { startLoops, type Loops } from './loops.ts';

/**
 * Обход исполнителей отдаёт каждому `runTask` порты этапа 11 (P141, Q-2): место сеанса шаг берёт
 * до запуска сеанса, суд `next` спрашивает детей XL каждый круг. Без проброса места не считались бы, а
 * родитель XL кончался бы, не дождавшись детей. Реестр и журнал настоящие; подделаны дорога
 * (запуска нет), переходник и сами порты — их проводки проверяют свои тесты.
 */

const opened: { loops: Loops; registry: TaskRegistry }[] = [];
afterEach(async () => {
  for (const s of opened.splice(0)) {
    await s.loops.stop();
    s.registry.closeAll();
  }
});

const road = (): SessionRoad =>
  ({
    prepare: async () => ({ ok: false, reason: 'test road launches nothing' }),
    attach: () => ({ done: new Promise<void>(() => undefined), detach: () => undefined }),
    releaseTask: async () => ({ verified: [], leaks: [], unread: [] }),
  }) as unknown as SessionRoad;

const adapters = (): AdapterRegistry => {
  const adapter = { id: 'claude' } as unknown as CliAdapter;
  return {
    get: (id) => (id === 'claude' ? adapter : undefined),
    ids: () => ['claude'],
    all: () => [adapter],
  };
};

const decision = { order: [], grant: [], reasons: [] };

class Seats implements SeatPort {
  readonly asks: SeatAsk[] = [];
  acquire(ask: SeatAsk): Promise<SeatAnswer> {
    this.asks.push(ask);
    return Promise.resolve({ granted: true, ticketId: 'tk', decision });
  }
  bind(): void {}
  release(): void {}
  subscribe(): () => void {
    return () => undefined;
  }
}

async function until(probe: () => boolean, what: string, ms = 5_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!probe()) {
    if (Date.now() > deadline) throw new Error(`timeout: ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

async function launched(registry: TaskRegistry): Promise<LiveTask> {
  const task = await registry.create({
    ...CREATED,
    modelCeiling: 'sonnet',
    allowedRoutes: [
      {
        adapter: 'claude',
        route: { kind: 'cli-login', id: 'cli-login:claude' },
        modelPattern: '*',
      },
    ],
  });
  task.append({
    kind: 'task.transition',
    actor: 'core',
    data: { taskId: task.taskId, event: 'launch', from: 'draft', to: 'running' },
  });
  return task;
}

describe('product loops hand the stage-11 ports to every runner', () => {
  it('the seat port is asked for the step that tries to start; the XL port is asked for this task', async () => {
    const registry = createTaskRegistry(tempDir('loops-ports-'), deps());
    const scenariosDir = tempDir('loops-ports-sc-');
    await writeLibraryScenario(scenariosDir, MINI_SCENARIO);
    const seats = new Seats();
    const xlAsked: string[] = [];
    const xl: XlPort = {
      childrenOf: (task) => {
        xlAsked.push(task.taskId);
        return null;
      },
      launch: async () => undefined,
    };
    const refused: string[] = [];
    const loops = startLoops({
      registry,
      road: road(),
      adapters: adapters(),
      scenariosDir,
      hooks: [],
      // Копии у единицы нет — запуск сеанса отказан; место шаг спросил раньше, до крючков брифа.
      note: (event, data) => {
        if (event === 'loop.start-refused') refused.push(String(data.stepId));
      },
      options: { sweepMs: 60_000, pin: () => ({}) },
      allocator: seats,
      xl,
    });
    opened.push({ loops, registry });
    const task = await launched(registry);
    void loops.sweep();
    await until(() => refused.length > 0, 'the first step tried to start');
    expect(seats.asks.map((a) => [a.taskId, a.stepId])).toContainEqual([task.taskId, refused[0]]);
    expect(xlAsked).toContain(task.taskId);
  });
});
