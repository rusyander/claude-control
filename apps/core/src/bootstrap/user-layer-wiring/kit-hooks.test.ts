import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { JournalLine } from '@agentdeck/contracts/core/journal';
import { describe, expect, it } from 'vitest';
import type { AdapterEvent, CliAdapter, SessionLayerCarry } from '../../adapters/adapter.types.ts';
import { createClaudeAdapter } from '../../adapters/claude/claude.ts';
import { seedSession } from '../../conductor/model-tools/__fixtures__/seed.ts';
import { CREATED, openFresh, tempDir } from '../../journal/__fixtures__/journal-harness.ts';
import { readJournalLines } from '../../journal/read-lines.ts';
import { layoutOf } from '../../platform/core-home.ts';
import { createSessionRoad } from '../session-road/road.ts';
import type { RoadStart } from '../session-road/road.types.ts';
import { createUserLayerTap } from './tap.ts';

/**
 * R2, 06:121-122 — безымянный отказ хука набора панели (`agent-prompt-guard` за диспетчером
 * `hooks/lib/run.mjs pre`) называет кандидата. Набор едет в сеанс плагином (`carry.plugins` →
 * `--plugin-dir`), не файлом настроек человека: опись, читавшая только `settings.json`, давала
 * «candidates by matcher: none». Путь настоящий: дом CLI во временном каталоге, плагин — копия
 * НАСТОЯЩИХ `plugin.json` и `hooks/hooks.json` набора, опись — настоящая опись Claude через книгу
 * слоя дороги, кандидаты — кран слоя, как его проводит `boot-core` (`road.layerInventory`).
 */

const KIT = fileURLToPath(new URL('../../../../server/assets/kit/agentdeck-kit/', import.meta.url));

/** Набор, собранный панелью под режим (`effective/<режим>/agentdeck-kit`), — его файлы хуков. */
function composedKit(root: string): string {
  const dir = join(root, 'effective', 'hybrid', 'agentdeck-kit');
  for (const file of [join('.claude-plugin', 'plugin.json'), join('hooks', 'hooks.json')]) {
    mkdirSync(dirname(join(dir, file)), { recursive: true });
    copyFileSync(join(KIT, file), join(dir, file));
  }
  return dir;
}

/** Группа `PreToolUse` набора, чей matcher ловит `Agent`, — по самому файлу набора. */
function kitAgentGroup(kit: string): number {
  const doc = JSON.parse(readFileSync(join(kit, 'hooks', 'hooks.json'), 'utf8')) as {
    hooks: { PreToolUse: { matcher?: string }[] };
  };
  return doc.hooks.PreToolUse.findIndex((g) =>
    new RegExp(`^(?:${g.matcher ?? '.*'})$`).test('Agent'),
  );
}

async function stand(carry: (kit: string) => SessionLayerCarry | undefined) {
  const home = tempDir('kit-home-');
  const config = join(home, '.claude');
  mkdirSync(config, { recursive: true });
  // Свой хук человека — на Bash: Agent не ловит, кандидатом отказа субагенту быть не должен.
  writeFileSync(
    join(config, 'settings.json'),
    JSON.stringify({
      hooks: {
        PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'node guard.mjs' }] }],
      },
    }),
  );
  const kit = composedKit(tempDir('kit-panel-'));
  const { task } = await openFresh();
  task.append({
    kind: 'task.created',
    actor: 'core',
    data: { ...CREATED, repos: [{ repoKey: 'r1', path: tempDir('src-'), baseRef: 'main' }] },
  });
  const seeded = seedSession(task, { stepKind: 'chat' });
  const adapter: CliAdapter = createClaudeAdapter();
  const road = createSessionRoad({
    layout: layoutOf(tempDir('core-home-')),
    adapters: { get: (id: string) => (id === 'claude' ? adapter : undefined) },
  } as never);
  const layerCarry = carry(kit);
  const start = {
    task,
    stepId: seeded.stepId,
    stepKind: 'chat',
    sessionId: seeded.sessionId,
    adapterId: 'claude',
    model: null,
    cwd: tempDir('copy-'),
    dir: tempDir('session-'),
    deny: { paths: [], commands: [], mcpTools: [], tools: [] },
    layer: { hooks: 'on', skills: 'on', ...(layerCarry ? { carry: layerCarry } : {}) },
    pin: { CLAUDE_CONFIG_DIR: config, HOME: home, USERPROFILE: home },
  } as unknown as RoadStart;
  // Прикрепление сеанса ставит книгу слоя (ленивая опись) — как `loop.ts` до первой строки потока.
  road.contextFor(start);
  const binding = {
    taskId: task.taskId,
    sessionId: seeded.sessionId,
    stepId: seeded.stepId,
    unitId: seeded.unitId,
    stepKind: 'chat',
  };
  const tap = createUserLayerTap({
    inventoryOf: (_task, b) => road.layerInventory(b.sessionId),
  });
  const events: AdapterEvent[] = [
    {
      type: 'tool.requested',
      toolUseId: 't1',
      name: 'Agent',
      input: { subagent_type: 'general-purpose', prompt: 'x' },
      cliInitiated: false,
      parentToolUseId: null,
    },
    {
      type: 'hook.refused',
      toolUseId: 't1',
      event: 'PreToolUse',
      hook: null,
      reason: 'agent-prompt-guard: the spawn prompt lacks [return-format]',
      cliInitiated: false,
    },
  ];
  for (const event of events) tap.onEvent(task, binding, event);
  const decision = readJournalLines(task.dir, task.taskId).lines.find(
    (l) => l.kind === 'decision' && (l as JournalLine<'decision'>).data.class === 'hook-block',
  ) as JournalLine<'decision'> | undefined;
  return { kit, decision, inventory: road.layerInventory(seeded.sessionId) };
}

describe('hook-block candidates: hooks of the panel kit plugin (R2)', () => {
  it('an unnamed refusal of an Agent call names the kit dispatcher hook as its candidate', async () => {
    const s = await stand((kit) => ({ plugins: [kit] }));
    const key = `agentdeck-kit:PreToolUse.${kitAgentGroup(s.kit)}.0`;
    expect(s.decision?.data.output).toMatchObject({
      signal: 'hook-block',
      subject: 'unidentified user hook',
      candidates: [key],
    });
    expect(s.decision?.data.reasons).toEqual([
      `the CLI did not name the hook; candidates by matcher: ${key}`,
    ]);
    const hook = s.inventory?.hooks.find((h) => h.key === key);
    expect(hook?.command).toContain('hooks/lib/run.mjs');
    expect(hook?.sourcePath).toBe(join(s.kit, 'hooks', 'hooks.json'));
    // Файл хуков набора — источник описи: правка набора меняет её хеш.
    expect(s.inventory?.sources.map((x) => x.path)).toContain(join(s.kit, 'hooks', 'hooks.json'));
  });

  it('without the kit plugin in the session the same refusal has no candidate', async () => {
    const s = await stand(() => undefined);
    expect(s.decision?.data.output).toMatchObject({ candidates: [] });
  });
});
