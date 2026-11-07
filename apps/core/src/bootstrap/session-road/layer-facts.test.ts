import type { UserLayerInventory } from '@agentdeck/contracts/core/user-layer';
import { describe, expect, it } from 'vitest';
import { claudeRunFacts } from '@agentdeck/providers/claude';
import { tierLadderOf } from '@agentdeck/providers/ladder';
import type { CliAdapter, PermissionAsk } from '../../adapters/adapter.types.ts';
import { mapClaudePermission } from '../../adapters/claude/permission.ts';
import { SdkNormaliser } from '../../adapters/sdk-stream/normalise.ts';
import { seedSession } from '../../conductor/model-tools/__fixtures__/seed.ts';
import { createEconomyWiring } from '../economy-wiring/index.ts';
import { CREATED, openFresh, tempDir } from '../../journal/__fixtures__/journal-harness.ts';
import { layoutOf } from '../../platform/core-home.ts';
import { decidePermit } from '../../policy/permit/permit.ts';
import { createSessionRoad } from './road.ts';
import type { RoadStart } from './road.types.ts';

/**
 * Факты слоя в контексте права настоящей дорогой сессии (06:115, 06:124, G5): режим навыков —
 * из запуска шага, подагенты — из `caps.subagentHooks` переходника, модель определения — из описи
 * слоя сеанса. До этапа 7 дорога этих полей не ставила, и навык с подагентом отказывались всегда.
 */

const INVENTORY: UserLayerInventory = {
  cli: 'claude',
  hash: 'h1',
  sources: [],
  hooks: [],
  skills: [],
  agents: [
    { name: 'big', model: 'opus', path: '/a/big.md' },
    { name: 'plain', model: null, path: '/a/plain.md' },
  ],
  unread: [],
};

const skill: PermissionAsk = {
  action: 'skill',
  target: 'review',
  tool: 'Skill',
  display: 'Skill review',
};
const agent = (target: string, model: string | null = null): PermissionAsk => ({
  action: 'subagent',
  target,
  model,
  tool: 'Agent',
  display: `Agent ${target}`,
});

async function stand(opts: {
  skills: 'on' | 'off';
  subagentHooks: boolean | null;
  /** Задача под ведением (`task.created.lead`, этап 11) и вид шага сеанса; по умолчанию — нет и work. */
  lead?: boolean;
  stepKind?: string;
  /** Лестница настоящего переходника Claude (факты запуска); нет — лестницы нет. */
  ladder?: boolean;
  /** Модель сеанса (`start.model`); нет — модель CLI по умолчанию. */
  model?: string;
}) {
  const home = tempDir('core-home-');
  const { task } = await openFresh();
  const stepKind = opts.stepKind ?? 'work';
  task.append({
    kind: 'task.created',
    actor: 'core',
    data: {
      ...CREATED,
      repos: [{ repoKey: 'r1', path: tempDir('src-'), baseRef: 'main' }],
      ...(opts.lead ? { lead: { profile: 'balanced' as const } } : {}),
    },
  });
  const seeded = seedSession(task, { stepKind });
  const reads: boolean[] = [];
  const ladder = opts.ladder ? tierLadderOf(claudeRunFacts) : undefined;
  const adapter = {
    id: 'claude',
    ...(ladder ? { ladder } : {}),
    caps: { subagentHooks: opts.subagentHooks },
    readLayer: () => ({ dirs: [], credentials: [] }),
    inventory: (_pin: Record<string, string>, _cwd: string, repoLayer: boolean) => {
      reads.push(repoLayer);
      return INVENTORY;
    },
  } as unknown as CliAdapter;
  const road = createSessionRoad({
    layout: layoutOf(home),
    adapters: { get: (id: string) => (id === 'claude' ? adapter : undefined) },
  } as never);
  const start = {
    task,
    stepId: seeded.stepId,
    stepKind,
    sessionId: seeded.sessionId,
    adapterId: 'claude',
    model: opts.model ?? null,
    cwd: tempDir('copy-'),
    dir: tempDir('session-'),
    deny: { paths: [], commands: [], mcpTools: [], tools: [] },
    layer: { hooks: 'on', skills: opts.skills },
    pin: {},
  } as unknown as RoadStart;
  const binding = {
    taskId: task.taskId,
    sessionId: seeded.sessionId,
    stepId: seeded.stepId,
    unitId: seeded.unitId,
    stepKind,
  };
  return { road, start, reads, sessionId: seeded.sessionId, task, binding };
}

/**
 * Первое сообщение сеанса, как его пишет Claude Code (`--include-partial-messages`): `system/init`
 * с моделью, `message_start` с именем модели, `message_stop` — через НАСТОЯЩИЙ разбор потока в кран
 * экономики, который пишет `modelServed` в журнал (P119). Никакой подстановки имени в свёртку.
 */
function cliReports(s: Awaited<ReturnType<typeof stand>>, model: string): void {
  const n = new SdkNormaliser({ echo: false, mapPermission: mapClaudePermission });
  n.expect('c1', 'u1');
  const lines = [
    { type: 'system', subtype: 'init', session_id: 'conv-1', model, tools: [], mcp_servers: [] },
    {
      type: 'stream_event',
      event: { type: 'message_start', message: { id: 'm1', model, usage: { input_tokens: 5 } } },
    },
    { type: 'stream_event', api_message_id: 'm1', event: { type: 'message_stop' } },
  ];
  const tap = createEconomyWiring();
  for (const event of lines.flatMap((o) => n.push(JSON.stringify(o))))
    tap.onEvent(s.task, s.binding, event);
}

describe('session road: user layer facts in the permit context', () => {
  it('skills follow the step launch mode: on allows a Skill call, off denies it as skills-off', async () => {
    const on = await stand({ skills: 'on', subagentHooks: true });
    expect(decidePermit(skill, on.road.contextFor(on.start), 'work')).toMatchObject({
      allow: true,
    });
    const off = await stand({ skills: 'off', subagentHooks: true });
    expect(decidePermit(skill, off.road.contextFor(off.start), 'work')).toMatchObject({
      allow: false,
      code: 'skills-off',
    });
  });

  it('subagents run only where the adapter proved core hooks hold inside them', async () => {
    const proven = await stand({ skills: 'on', subagentHooks: true });
    expect(
      decidePermit(agent('plain'), proven.road.contextFor(proven.start), 'work'),
    ).toMatchObject({
      allow: true,
    });
    const unproven = await stand({ skills: 'on', subagentHooks: null });
    expect(
      decidePermit(agent('plain'), unproven.road.contextFor(unproven.start), 'work'),
    ).toMatchObject({ allow: false, code: 'subagent-unproven' });
  });

  it('a definition model from the session inventory is judged, not waved through as the session model', async () => {
    const s = await stand({ skills: 'on', subagentHooks: true });
    const ctx = s.road.contextFor(s.start);
    const big = decidePermit(agent('big'), ctx, 'work');
    expect(big).toMatchObject({ allow: false, code: 'subagent-model-unknown' });
    expect(big.reason).toContain('definition big');
    // Опись прочитана лениво, один раз, со слоем репозитория: строки старта со слоем у сеанса нет.
    decidePermit(agent('big'), ctx, 'work');
    expect(s.reads).toEqual([true]);
    expect(s.road.layerInventory(s.sessionId)?.hash).toBe('h1');
  });

  it('a unit session of a lead-routed task calls no subagent (lead-worker); its chat and a task without lead still may', async () => {
    const worker = await stand({ skills: 'on', subagentHooks: true, lead: true });
    const denied = decidePermit(agent('plain'), worker.road.contextFor(worker.start), 'work');
    expect(denied).toMatchObject({ allow: false, code: 'lead-worker' });
    expect(denied.reason).toContain('subagent plain');
    // Суд по типизированному действию: у другого CLI инструмент зовётся иначе — отказ тот же.
    const renamed = { ...agent('plain'), tool: 'spawn_agent', display: 'spawn_agent plain' };
    expect(decidePermit(renamed, worker.road.contextFor(worker.start), 'work')).toMatchObject({
      allow: false,
      code: 'lead-worker',
    });
    // Навык — не подагент: правило его не трогает.
    expect(decidePermit(skill, worker.road.contextFor(worker.start), 'work')).toMatchObject({
      allow: true,
    });
    const chat = await stand({
      skills: 'on',
      subagentHooks: true,
      lead: true,
      stepKind: 'chat',
    });
    expect(decidePermit(agent('plain'), chat.road.contextFor(chat.start), 'chat')).toMatchObject({
      allow: true,
    });
    const plain = await stand({ skills: 'on', subagentHooks: true });
    expect(decidePermit(agent('plain'), plain.road.contextFor(plain.start), 'work')).toMatchObject({
      allow: true,
    });
  });
});

describe('session road: subagent ceiling of a session on the CLI default model (03:147)', () => {
  it('a chat on the default model takes the model the CLI reported for this session as its ceiling', async () => {
    const chat = await stand({ skills: 'on', subagentHooks: true, ladder: true, stepKind: 'chat' });
    // Контекст судьи ставится при прикреплении сеанса — до первой строки потока, как в `loop.ts`.
    const ctx = chat.road.contextFor(chat.start);
    cliReports(chat, 'claude-sonnet-4-5-20250929');
    expect(chat.task.state.sessions[chat.sessionId]!.modelServed).toBe(
      'claude-sonnet-4-5-20250929',
    );
    expect(decidePermit(agent('plain', 'sonnet'), ctx, 'chat')).toEqual({
      allow: true,
      signal: null,
      reason:
        'subagent plain: requested model sonnet within the session ceiling claude-sonnet-4-5-20250929 (reported by the CLI)',
    });
    expect(decidePermit(agent('plain', 'haiku'), ctx, 'chat')).toMatchObject({ allow: true });
    expect(decidePermit(agent('plain', 'opus'), ctx, 'chat')).toMatchObject({
      allow: false,
      code: 'model-above-ceiling',
      reason:
        'subagent plain: requested model opus is above the session ceiling claude-sonnet-4-5-20250929 (reported by the CLI)',
    });
  });

  it('nothing reported yet: a chat allows an explicit ranked model, says no ceiling is known; unranked still denied', async () => {
    const chat = await stand({ skills: 'on', subagentHooks: true, ladder: true, stepKind: 'chat' });
    const ctx = chat.road.contextFor(chat.start);
    expect(decidePermit(agent('plain', 'opus'), ctx, 'chat')).toEqual({
      allow: true,
      signal: null,
      reason:
        'subagent plain: requested model opus, no ceiling is known for this chat (the session runs the CLI default model, none reported yet)',
    });
    expect(decidePermit(agent('plain', 'mystery-model'), ctx, 'chat')).toMatchObject({
      allow: false,
      code: 'subagent-model-unknown',
    });
  });

  it('a task unit on the default model: the reported model is its ceiling; nothing reported — denied', async () => {
    const unit = await stand({ skills: 'on', subagentHooks: true, ladder: true });
    const ctx = unit.road.contextFor(unit.start);
    expect(decidePermit(agent('plain', 'sonnet'), ctx, 'work')).toEqual({
      allow: false,
      code: 'subagent-model-unknown',
      reason: 'subagent plain: requested model sonnet, but the ceiling rank is unknown',
      humanPoint: null,
    });
    cliReports(unit, 'claude-opus-4-1-20250805');
    expect(decidePermit(agent('plain', 'sonnet'), ctx, 'work')).toMatchObject({ allow: true });
    expect(decidePermit(agent('plain', 'fable'), ctx, 'work')).toMatchObject({
      allow: false,
      code: 'model-above-ceiling',
    });
  });

  it('a named session model stays the ceiling: a reported model never widens it', async () => {
    const chat = await stand({
      skills: 'on',
      subagentHooks: true,
      ladder: true,
      stepKind: 'chat',
      model: 'sonnet',
    });
    const ctx = chat.road.contextFor(chat.start);
    cliReports(chat, 'claude-opus-4-1-20250805');
    expect(decidePermit(agent('plain', 'opus'), ctx, 'chat')).toMatchObject({
      allow: false,
      code: 'model-above-ceiling',
      reason: 'subagent plain: requested model opus is above the task ceiling',
    });
  });
});
