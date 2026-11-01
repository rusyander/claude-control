import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { JournalLine } from '@agentdeck/contracts/core/journal';
import type { UserLayerInventory } from '@agentdeck/contracts/core/user-layer';
import { afterAll, describe, expect, it } from 'vitest';
import type { AdapterEvent, CliAdapter, SessionHandle } from '../adapters/index.ts';
import { claudeInventory } from '../adapters/claude/layer-parts.ts';
import { createUserLayerTap } from '../bootstrap/user-layer-wiring/tap.ts';
import { createSessionRuntime } from '../bootstrap/session-runtime.ts';
import { launchLint } from '../conductor/lint/launch-lint.ts';
import { seedSession } from '../conductor/model-tools/__fixtures__/seed.ts';
import { bindingOf } from '../conductor/model-tools/binding.ts';
import { createTaskRegistry } from '../conductor/tasks.ts';
import { CREATED, deps } from '../journal/__fixtures__/journal-harness.ts';
import { readJournalLines } from '../journal/read-lines.ts';
import type { PermitContext } from '../policy/permit/permit.types.ts';
import { LAYER_SETS_TASK } from './__fixtures__/library/stage7-s.ts';
import {
  LAYER_SETS,
  layerSetDir,
  plantLayerSet,
  type LayerSetName,
} from './__fixtures__/layer-sets/plant.ts';

/**
 * P36 (08:49) на уровне блока, над библиотекой заглушек: каждый набор слоя посажен в одноразовый
 * дом CLI и прочитан НАСТОЯЩЕЙ описью Claude (`claudeInventory`); линт запуска — по её текстам;
 * ходы задачи `layer-sets` идут событиями через настоящий рантайм сессии с краном слоя. Враждебный
 * набор даёт отказы хуков в форме §Probe (exit 2 → ключ описи; Stop — без имени, 9 подряд —
 * предел CLI). Свойство: журнал за вычетом названных строк хуков одинаков во всех наборах.
 * Живой уровень (настоящий claude) — `layer-sets.live.integration.test.ts`.
 */

const roots: string[] = [];
afterAll(() => {
  for (const r of roots)
    rmSync(r, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

const CONTEXT: PermitContext = {
  copyRoot: '/copy',
  ownedPaths: [],
  deny: { paths: [], commands: [], mcpTools: [], tools: [] },
  platformPaths: [],
  endpointSources: [],
  grantRequired: [],
  grants: [],
};
const STEP_DONE_TOOL = 'mcp__agentdeck__step_done';
/** Предел CLI подряд идущих блоков Stop (`CLAUDE_CODE_STOP_HOOK_BLOCK_CAP`, §Probe Q3). */
const STOP_CAP = 9;

function planted(name: LayerSetName): {
  inventory: UserLayerInventory;
  texts: { path: string; text: string }[];
} {
  const root = mkdtempSync(join(tmpdir(), `layer-set-${name}-`));
  roots.push(root);
  const home = join(root, 'home');
  const cwd = join(root, 'repo');
  mkdirSync(cwd, { recursive: true });
  plantLayerSet(layerSetDir(name), join(home, '.claude'), join(root, 'markers'));
  const inventory = claudeInventory({ HOME: home, USERPROFILE: home }, cwd, true);
  const texts = inventory.sources.map((s) => ({
    path: s.path,
    text: readFileSync(s.path, 'utf8'),
  }));
  return { inventory, texts };
}

/** Ходы заглушки событиями потока: вызов на каждый ход (ходы от слоя не зависят). */
function callsOf(): { id: string; name: string; input: unknown }[] {
  return LAYER_SETS_TASK.moves.flatMap((move, i) => {
    const id = `call-${i}`;
    if (move.op === 'write')
      return [{ id, name: 'Write', input: { file_path: move.path, content: move.content } }];
    if (move.op === 'shell') return [{ id, name: 'Bash', input: { command: move.argv.join(' ') } }];
    if (move.op === 'model-tool')
      return [{ id, name: `mcp__agentdeck__${move.tool}`, input: move.args }];
    return [];
  });
}

/** Отказ хука в форме §Probe: exit 2 → ключ описи по событию и matcher; Stop — без имени. */
function streamOf(inventory: UserLayerInventory): AdapterEvent[] {
  const keyFor = (tool: string) =>
    inventory.hooks.find(
      (h) => h.event === 'PreToolUse' && h.matcher === tool && h.command.includes('deny.mjs'),
    )?.key;
  const events: AdapterEvent[] = [];
  for (const call of callsOf()) {
    events.push({
      type: 'tool.requested',
      toolUseId: call.id,
      name: call.name,
      input: call.input,
      cliInitiated: false,
    });
    const key = keyFor(call.name);
    if (key)
      events.push({
        type: 'hook.refused',
        toolUseId: call.id,
        event: 'PreToolUse',
        hook: key,
        reason: 'blocked',
        cliInitiated: false,
      });
  }
  if (inventory.hooks.some((h) => h.event === 'Stop' && h.command.includes('stop-block.mjs')))
    for (let i = 0; i < STOP_CAP; i += 1)
      events.push({
        type: 'hook.refused',
        toolUseId: null,
        event: 'Stop',
        hook: null,
        reason: 'Push the branch',
        cliInitiated: true,
      });
  return events;
}

async function run(inventory: UserLayerInventory) {
  const registry = createTaskRegistry(
    join(mkdtempSync(join(tmpdir(), 'layer-run-')), 'tasks'),
    deps(),
  );
  const task = await registry.create(CREATED);
  const { sessionId, stepId } = seedSession(task, { stepKind: 'work' });
  const got = bindingOf(task, sessionId);
  if (!('binding' in got)) throw new Error(got.reason);
  const events = streamOf(inventory);
  const adapter = {
    id: 'claude',
    events: async function* () {
      for (const e of events) yield e;
    },
    mapPermission: () => ({ action: 'other', target: '', tool: '', display: '' }),
  } as unknown as CliAdapter;
  await createSessionRuntime({
    note: () => undefined,
    userLayer: createUserLayerTap({ inventoryOf: () => inventory }),
  }).attach({
    task,
    binding: got.binding,
    adapter,
    handle: { sessionId } as SessionHandle,
    context: CONTEXT,
    resumed: false,
    onEvent: () => {},
  }).done;
  const lines = readJournalLines(task.dir, task.taskId).lines;
  const stops = task.state.steps[stepId]?.stops ?? [];
  registry.closeAll();
  return { lines, stops };
}

const isHookLine = (l: JournalLine): boolean => {
  if (l.kind === 'signal')
    return ['hook-block', 'hook-loop'].includes((l as JournalLine<'signal'>).data.signal);
  if (l.kind === 'decision') {
    const d = (l as JournalLine<'decision'>).data;
    return (
      ['hook-block', 'hook-loop'].includes(d.class) &&
      ['hook-block', 'hook-loop'].includes((d.output as { signal?: string }).signal ?? '')
    );
  }
  return false;
};

/** Журнал без идентификаторов и времени: вид, класс, сигнал — то, что решило ядро. */
const shape = (lines: readonly JournalLine[]) =>
  lines
    .filter((l) => !isHookLine(l))
    .map((l) => {
      if (l.kind === 'decision') return `decision:${(l as JournalLine<'decision'>).data.class}`;
      if (l.kind === 'signal') return `signal:${(l as JournalLine<'signal'>).data.signal}`;
      return l.kind;
    });

describe('P36 layer sets over the stub library (unit level)', () => {
  const sets = Object.fromEntries(LAYER_SETS.map((n) => [n, planted(n)])) as Record<
    LayerSetName,
    ReturnType<typeof planted>
  >;

  it('every set plants into a temp CLI home and the real Claude inventory reads it: hooks keyed, sizes as designed, hashes distinct', () => {
    expect(sets.none.inventory.hooks).toEqual([]);
    expect(sets.none.inventory.sources).toEqual([]);
    expect(sets['synthetic-large'].inventory.hooks.map((h) => h.event).sort()).toEqual([
      'PostToolUse',
      'PreToolUse',
      'PreToolUse',
      'Stop',
      'UserPromptSubmit',
    ]);
    expect(sets['synthetic-large'].inventory.sources.length).toBeGreaterThanOrEqual(45);
    expect(sets.hostile.inventory.hooks.map((h) => `${h.event}:${h.matcher ?? ''}`).sort()).toEqual(
      ['PreToolUse:Bash', `PreToolUse:${STEP_DONE_TOOL}`, 'Stop:', 'UserPromptSubmit:'],
    );
    expect(new Set(LAYER_SETS.map((n) => sets[n].inventory.hash)).size).toBe(3);
  });

  it('launch lint flags every process rule of the hostile set and nothing in the large neutral set', () => {
    const lint = (n: LayerSetName) =>
      launchLint(sets[n].inventory, sets[n].texts, (t) => t).map((w) => w.rule);
    expect(lint('none')).toEqual([]);
    expect(lint('synthetic-large')).toEqual([]);
    expect(new Set(lint('hostile'))).toEqual(
      new Set(['push', 'mr', 'merge', 'ci-wait', 'whole-suite', 'approve', 'frontmatter-key']),
    );
  });

  it('the journal minus named hook lines is identical across sets; hostile names each hook and stops the Stop loop', async () => {
    const runs = Object.fromEntries(
      await Promise.all(LAYER_SETS.map(async (n) => [n, await run(sets[n].inventory)] as const)),
    ) as Record<LayerSetName, Awaited<ReturnType<typeof run>>>;
    expect(shape(runs['synthetic-large'].lines)).toEqual(shape(runs.none.lines));
    expect(shape(runs.hostile.lines)).toEqual(shape(runs.none.lines));
    expect(runs.none.lines.filter(isHookLine)).toEqual([]);
    expect(runs['synthetic-large'].lines.filter(isHookLine)).toEqual([]);

    const hostileHooks = sets.hostile.inventory.hooks;
    const bashKey = hostileHooks.find((h) => h.matcher === 'Bash')?.key;
    const doneKey = hostileHooks.find((h) => h.matcher === STEP_DONE_TOOL)?.key;
    const stopKey = hostileHooks.find((h) => h.event === 'Stop')?.key;
    const signals = runs.hostile.lines
      .filter((l) => l.kind === 'signal')
      .map((l) => (l as JournalLine<'signal'>).data)
      .map((d) => `${d.signal}:${d.severity}:${d.subject}`);
    expect(signals).toEqual([
      `hook-block:warn:${bashKey}`,
      `hook-block:warn:${bashKey}`,
      `hook-block:warn:${doneKey}`,
      ...Array.from({ length: STOP_CAP }, (_, i) =>
        i === 2
          ? ['hook-block:warn:unidentified user hook', 'hook-loop:stop:unidentified user hook']
          : ['hook-block:warn:unidentified user hook'],
      ).flat(),
    ]);
    expect(runs.hostile.stops).toEqual(['hook-loop: unidentified user hook']);
    const stopCandidates = runs.hostile.lines
      .filter((l) => l.kind === 'decision')
      .map(
        (l) =>
          (l as JournalLine<'decision'>).data.output as {
            candidates?: string[];
            refusal?: { event: string };
          },
      )
      .filter((o) => o.refusal?.event === 'Stop')
      .map((o) => o.candidates);
    expect(stopCandidates[0]).toEqual([stopKey]);
  });
});
