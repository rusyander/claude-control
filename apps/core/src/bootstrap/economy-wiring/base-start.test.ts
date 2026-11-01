import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { AdapterEvent, CliAdapter, SessionHandle } from '../../adapters/index.ts';
import { seedSession } from '../../conductor/model-tools/__fixtures__/seed.ts';
import { bindingOf } from '../../conductor/model-tools/binding.ts';
import type { BriefSection, StepCtx } from '../../conductor/run/run.types.ts';
import { createTaskRegistry } from '../../conductor/tasks.ts';
import type { ProbeTrace } from '../../context/base/index.ts';
import { WindowBook } from '../../economy/window/index.ts';
import { CREATED, deps, tempDir } from '../../journal/__fixtures__/journal-harness.ts';
import { readJournalLines } from '../../journal/read-lines.ts';
import type { LiveTask } from '../../journal/resume.ts';
import type { PermitContext } from '../../policy/permit/permit.types.ts';
import { createSessionRuntime } from '../session-runtime.ts';
import type { Prepared } from '../session-road/road.types.ts';
import { baseAtStart } from './base-start.ts';
import { createContextWiring } from './context.ts';
import { createRunEconomy } from './continuation.ts';
import { createEconomyWiring } from './index.ts';

/**
 * Замер базы на старте и дрейф первого хода на настоящих проводках: контекст C (кэш замера в
 * доме, строка `context.base`), экономика исполнителя (первое слово), кран рантайма сессий
 * (первый `usage`). Подменены только проба CLI на заглушке (внешняя граница — CLI) и переходник.
 */

const CONTEXT: PermitContext = {
  copyRoot: '/copy',
  ownedPaths: [],
  deny: { paths: [], commands: [], mcpTools: [], tools: [] },
  platformPaths: [],
  endpointSources: [],
  grantRequired: [],
  grants: [],
};

const BRIEF_MARK = 'AGENTDECK_BASE_PROBE x';
/** Тело пробы: 40 000 байт системной части + метка — база ≈ 10 000 токенов. */
const TRACE: ProbeTrace = { bodies: [`${'s'.repeat(40_000)}${BRIEF_MARK}`], brief: BRIEF_MARK };

const parts: BriefSection[] = [
  { id: 'task', text: 'Сделать экспорт отчёта в CSV.', from: 'test' },
  { id: 'step', text: 'Шаг работы: правка и тесты.', from: 'test' },
];

function fakeAdapter(events: AdapterEvent[]): CliAdapter {
  return {
    id: 'claude',
    events: async function* () {
      for (const event of events) yield event;
    },
    mapPermission: () => ({ action: 'other', target: '', tool: '', display: '' }),
  } as unknown as CliAdapter;
}

const usage = (input: number): AdapterEvent => ({
  type: 'usage',
  messageId: 'm1',
  input,
  cacheRead: 0,
  cacheWrite: 0,
  output: 5,
});

function preparedOf(sessionId: string, endpoint = true): Prepared {
  // Ключ замера читает опись слоя человека (P87) — дом и каталог настроек одноразовые.
  const home = tempDir('base-start-layer-');
  return {
    adapter: { id: 'claude' },
    start: { stepKind: 'work', sessionId },
    spec: {
      dir: tempDir('base-start-'),
      layer: { hooks: 'off', skills: 'on' },
      tools: 'all',
      cwd: home,
      env: { pin: { CLAUDE_CONFIG_DIR: join(home, 'cfg'), HOME: home, USERPROFILE: home } },
      ...(endpoint
        ? {
            endpoint: {
              channel: { via: 'env' },
              endpoint: { baseUrl: 'http://127.0.0.1:1', dialect: 'anthropic-messages' },
            },
          }
        : {}),
    },
    mcpHash: 'a'.repeat(64),
  } as unknown as Prepared;
}

async function run(firstUsageBeforeArm: boolean, input: number) {
  const home = join(tempDir('base-start-home-'), 'core');
  const registry = createTaskRegistry(tempDir('base-start-tasks-'), deps());
  const task: LiveTask = await registry.create(CREATED);
  const { sessionId, stepId } = seedSession(task, { stepKind: 'work' });
  const context = createContextWiring({ homeRoot: home });
  const notes: string[] = [];
  let probes = 0;
  const measure = baseAtStart({
    context,
    note: (event) => notes.push(event),
    probe: async () => {
      probes += 1;
      return TRACE;
    },
    version: async () => '1.0.0',
  });
  const econ = createRunEconomy({ windows: new WindowBook(), now: Date.now, context });
  const tap = createEconomyWiring({ windows: new WindowBook(), context });
  const pump = async () => {
    const got = bindingOf(task, sessionId);
    if (!('binding' in got)) throw new Error(got.reason);
    await createSessionRuntime({ economy: tap }).attach({
      task,
      binding: got.binding,
      adapter: fakeAdapter([usage(input)]),
      handle: { sessionId } as SessionHandle,
      context: CONTEXT,
      resumed: false,
    }).done;
  };
  const ctx = { stepId, unitId: null, def: { kind: 'work' }, round: 0 } as unknown as StepCtx;
  if (firstUsageBeforeArm) await pump();
  expect(measure(task, preparedOf(sessionId))).toBe(true);
  // Замер в фоне: ждём его строку журнала, как дождался бы первый ход.
  for (let i = 0; i < 200 && task.state.bases.length === 0; i += 1)
    await new Promise((r) => setTimeout(r, 10));
  const text = await econ.opening!(task, ctx, sessionId, parts);
  // Поздний замер: следующий ход сессии (уже не первый) тоже не судится им.
  await pump();
  const signals = readJournalLines(task.dir, task.taskId)
    .lines.filter((l) => l.kind === 'signal')
    .map((l) => (l.data as { signal: string }).signal);
  return { task, text, signals, notes, probes, measure, sessionId };
}

describe('base measured at session start (G9)', () => {
  it('a first turn far above base + brief raises context-drift; one within it does not', async () => {
    const over = await run(false, 40_000);
    expect(over.probes).toBe(1);
    expect(over.task.state.bases).toHaveLength(1);
    expect(over.task.state.bases[0]).toMatchObject({ adapter: 'claude', stepKind: 'work' });
    expect(over.text).toContain('Сделать экспорт');
    expect(over.signals).toContain('context-drift');

    const base = over.task.state.bases[0]!.tokens;
    const within = await run(false, base + 40);
    expect(within.signals).not.toContain('context-drift');
  });

  it('a first turn that came before the measure is not judged by it; a login-route session is not probed', async () => {
    const late = await run(true, 40_000);
    expect(late.signals).not.toContain('context-drift');
    expect(late.measure(late.task, preparedOf(late.sessionId, false))).toBe(false);
  });
});
