import { learnedResetBodySchema } from '@agentdeck/contracts/core/commands';
import { coreConfigSchema, queueSectionSchema } from '@agentdeck/contracts/core/config';
import { DECISION_CLASS_IDS } from '@agentdeck/contracts/core/decisions';
import { DECISION_OUTCOMES, decisionOutcome } from '@agentdeck/contracts/core/decision-view';
import { estimateFieldsSchema, type EstimateReply } from '@agentdeck/contracts/core/estimate';
import type { SessionTicket } from '@agentdeck/contracts/core/records';
import { taskViewSchema } from '@agentdeck/contracts/core/task-view';
import {
  HUMAN_ASK_SOURCES,
  TELEMETRY_KINDS,
  dataSchemaFor,
} from '@agentdeck/contracts/core/journal';
import type { IntakeDecision } from '@agentdeck/contracts/core/intake';
import type { TaskClassDecision } from '@agentdeck/contracts/core/lead';
import { STEP_DONE_KIND_FIELDS, stepDoneSchema } from '@agentdeck/contracts/core/model-tools';
import { CORE_PANEL_ROUTES } from '@agentdeck/contracts/core/panel-api';
import { stepDefSchema } from '@agentdeck/contracts/core/scenario';
import { describe, expect, expectTypeOf, it } from 'vitest';
import { CREATED, MINI_SCENARIO } from './journal/__fixtures__/journal-harness.ts';

/**
 * Контракты этапа 11 (волна 1, W1-4): виды журнала ведущего и истории агентов, разделы `lead` и
 * `queue.sessionSlots`, классы решений `intake`/`classify`, сброс ключа обучения. Каждый вид — одна
 * золотая строка и отказ на мутанте. Модули, которых до этапа нет (`intake`/`lead`/`agents`),
 * грузятся внутри теста: на старых контрактах краснеет каждый тест, а не весь файл разом.
 */

const ID = '01920000-0000-7000-8000-00000000b011';
const ID2 = '01920000-0000-7000-8000-00000000b012';
const SHA = 'a'.repeat(64);

const ok = (kind: string, data: unknown): boolean => {
  const schema = dataSchemaFor(1, kind);
  if (!schema) throw new Error(`journal kind ${kind} is unknown`);
  return schema.safeParse(data).success;
};

const OWNER = {
  taskId: ID,
  stepId: ID,
  unitId: null,
  sessionId: ID,
  toolUseId: 'toolu_1',
  parentToolUseId: null,
};

const CARD = {
  goal: 'Ship the lead',
  acceptance: [{ requirementId: ID, text: 'class recorded', from: 'structured' }],
  area: { paths: ['apps/core/src'], units: ['core'] },
  constraints: [],
  unknowns: [],
  sourceDigest: SHA,
};

const SOURCE = { kind: 'text', body: 'do it', fetchedAt: 1, digest: SHA };

describe('stage-11 contracts', () => {
  it('tool.started: a call before its tool.event, telemetry, strict', () => {
    const row = {
      sessionId: ID,
      toolUseId: 'toolu_1',
      parentToolUseId: null,
      tool: 'Read',
      target: 'a.ts',
    };
    expect(ok('tool.started', row)).toBe(true);
    expect(ok('tool.started', { ...row, extra: 1 })).toBe(false);
    expect(ok('tool.started', { ...row, toolUseId: '' })).toBe(false);
    expect(TELEMETRY_KINDS).toContain('tool.started');
  });

  it('agent.spawned / agent.ended: CLI task id, masked excerpt, null usage is unknown', () => {
    const spawned = {
      sessionId: ID,
      toolUseId: 'toolu_2',
      parentToolUseId: null,
      cliTaskId: 't1',
      kind: 'subagent',
      subagentType: 'general-purpose',
      model: null,
      effort: null,
      background: false,
      depth: 1,
      briefExcerpt: 'look around',
    };
    expect(ok('agent.spawned', spawned)).toBe(true);
    expect(ok('agent.spawned', { ...spawned, kind: 'monitor' })).toBe(false);
    expect(ok('agent.spawned', { ...spawned, briefExcerpt: 'x'.repeat(2001) })).toBe(false);
    const ended = {
      sessionId: ID,
      toolUseId: 'toolu_2',
      cliTaskId: 't1',
      how: 'completed',
      usage: null,
      summaryExcerpt: null,
    };
    expect(ok('agent.ended', ended)).toBe(true);
    expect(
      ok('agent.ended', { ...ended, usage: { totalTokens: 10, toolUses: 1, durationMs: 5 } }),
    ).toBe(true);
    expect(ok('agent.ended', { ...ended, how: 'exit' })).toBe(false);
  });

  it('bg.started / bg.ended: full owner chain, strict (mutant: object instead of strictObject)', () => {
    const started = {
      itemId: 'b1',
      kind: 'background-shell',
      excerpt: 'pnpm dev',
      ownerChain: OWNER,
      pid: 42,
      startedAt: 1,
    };
    expect(ok('bg.started', started)).toBe(true);
    expect(ok('bg.started', { ...started, body: 'whole output' })).toBe(false);
    expect(ok('bg.started', { ...started, ownerChain: { ...OWNER, stepId: undefined } })).toBe(
      false,
    );
    expect(ok('bg.started', { ...started, kind: 'subagent' })).toBe(false);
    const ended = { itemId: 'b1', how: 'reaped', endedAt: 2 };
    expect(ok('bg.ended', ended)).toBe(true);
    expect(ok('bg.ended', { ...ended, how: 'completed' })).toBe(false);
  });

  it('intake.card: auto has no ask, a human card names its ask', () => {
    expect(ok('intake.card', { card: CARD, by: 'auto', askId: null })).toBe(true);
    expect(ok('intake.card', { card: CARD, by: 'human', askId: ID })).toBe(true);
    expect(ok('intake.card', { card: CARD, by: 'auto', askId: ID })).toBe(false);
    expect(ok('intake.card', { card: CARD, by: 'human', askId: null })).toBe(false);
    const unknown = { question: 'which?', recommendation: 'a', options: ['a', 'b'] };
    expect(
      ok('intake.card', { card: { ...CARD, unknowns: [unknown] }, by: 'auto', askId: null }),
    ).toBe(true);
    const offList = { ...unknown, recommendation: 'c' };
    expect(
      ok('intake.card', { card: { ...CARD, unknowns: [offList] }, by: 'auto', askId: null }),
    ).toBe(false);
    expect(
      ok('intake.card', {
        card: { ...CARD, unknowns: Array(5).fill(unknown) },
        by: 'auto',
        askId: null,
      }),
    ).toBe(false);
    expect(HUMAN_ASK_SOURCES).toContain('intake');
  });

  it('task.created: group, parent, lead profile and chat origin are optional additions', () => {
    expect(ok('task.created', CREATED)).toBe(true);
    const lead = {
      ...CREATED,
      groupId: 'g-1',
      parentTaskId: ID2,
      lead: { profile: 'balanced', class: 'M' },
      launchOrigin: { kind: 'chat', conversationId: 'conv-1' },
    };
    expect(ok('task.created', lead)).toBe(true);
    expect(ok('task.created', { ...lead, lead: { profile: 'lead' } })).toBe(false);
    expect(ok('task.created', { ...lead, lead: { profile: 'balanced', class: 'XXL' } })).toBe(
      false,
    );
    expect(
      ok('task.created', { ...lead, launchOrigin: { kind: 'tracker', conversationId: 'c' } }),
    ).toBe(false);
  });

  it('turn.usage: parentToolUseId names the subagent call; absent stays legal', () => {
    const row = {
      sessionId: ID,
      messageId: 'm1',
      input: 1,
      cacheRead: 0,
      cacheWrite: 0,
      cacheWrite1h: 0,
      output: 1,
      routeId: 'claude-sub',
      model: 'opus',
      subagent: true,
      parentSessionId: null,
      remainder: false,
    };
    expect(ok('turn.usage', row)).toBe(true);
    expect(ok('turn.usage', { ...row, parentToolUseId: 'toolu_2' })).toBe(true);
    expect(ok('turn.usage', { ...row, parentToolUseId: null })).toBe(true);
    expect(ok('turn.usage', { ...row, parentToolUseId: '' })).toBe(false);
  });

  it('lead section: role rows never carry effort max; parallelism 1..6; sessionSlots ≤ 6', async () => {
    const { leadSectionSchema, roleRowSchema, promotionSchema } =
      await import('@agentdeck/contracts/core/lead');
    expect(roleRowSchema.safeParse({ tier: 'ceiling', effort: 'high' }).success).toBe(true);
    expect(roleRowSchema.safeParse({ tier: 'ceiling', effort: 'max' }).success).toBe(false);
    expect(roleRowSchema.safeParse({ tier: 'opus' }).success).toBe(false);
    const section = {
      defaults: { profile: 'economy' },
      projects: { 'C:/work/p': { parallelism: 3, roles: { review: { tier: 'ceiling' } } } },
    };
    expect(leadSectionSchema.safeParse(section).success).toBe(true);
    expect(coreConfigSchema.safeParse({ lead: section }).success).toBe(true);
    expect(leadSectionSchema.safeParse({ defaults: { parallelism: 7 } }).success).toBe(false);
    expect(leadSectionSchema.safeParse({ defaults: { budget: 100 } }).success).toBe(false);
    expect(
      leadSectionSchema.safeParse({
        projects: { p: { roles: { review: { tier: 'ceiling', effort: 'max' } } } },
      }).success,
    ).toBe(false);
    expect(promotionSchema.safeParse({ threshold: 0.85, window: 20, minSamples: 21 }).success).toBe(
      false,
    );
    expect(queueSectionSchema.safeParse({ sessionSlots: 3 }).success).toBe(true);
    expect(queueSectionSchema.safeParse({ sessionSlots: 7 }).success).toBe(false);
  });

  it('class thresholds: defaults are the W2-8 table (S ≤3 files·1 unit, M ≤10·≤2, XL items ≥2 or units ≥5)', async () => {
    const { CLASS_THRESHOLDS_DEFAULT, classThresholdsSchema, leadSettingsSchema } =
      await import('@agentdeck/contracts/core/lead');
    expect(CLASS_THRESHOLDS_DEFAULT).toEqual({
      S: { files: 3, units: 1 },
      M: { files: 10, units: 2 },
      XL: { items: 2, units: 5 },
    });
    expect(classThresholdsSchema.safeParse(CLASS_THRESHOLDS_DEFAULT).success).toBe(true);
    // Граница L→XL — пункты и единицы со связями, а не число файлов.
    expect(
      classThresholdsSchema.safeParse({ ...CLASS_THRESHOLDS_DEFAULT, L: { files: 40, units: 5 } })
        .success,
    ).toBe(false);
    // XL по единицам не ниже M: иначе M-задача была бы XL.
    expect(
      classThresholdsSchema.safeParse({ ...CLASS_THRESHOLDS_DEFAULT, XL: { items: 2, units: 2 } })
        .success,
    ).toBe(false);
    // Один пункт — не группа.
    expect(
      classThresholdsSchema.safeParse({ ...CLASS_THRESHOLDS_DEFAULT, XL: { items: 1, units: 5 } })
        .success,
    ).toBe(false);
    const settings = {
      profile: 'balanced',
      parallelism: 4,
      promotion: { threshold: 0.85, window: 20, minSamples: 8 },
      classThresholds: CLASS_THRESHOLDS_DEFAULT,
    };
    // `alwaysAsk` — подмножество: повтор — ошибка автора, а не «спросить дважды».
    expect(
      leadSettingsSchema.safeParse({ ...settings, alwaysAsk: ['intake', 'split'] }).success,
    ).toBe(true);
    expect(
      leadSettingsSchema.safeParse({ ...settings, alwaysAsk: ['intake', 'intake'] }).success,
    ).toBe(false);
  });

  it('scenario step onlyFor: known classes only, never empty', () => {
    const step = MINI_SCENARIO.steps[0];
    expect(stepDefSchema.safeParse({ ...step, onlyFor: ['L', 'XL'] }).success).toBe(true);
    expect(stepDefSchema.safeParse({ ...step, onlyFor: ['XXL'] }).success).toBe(false);
    expect(stepDefSchema.safeParse({ ...step, onlyFor: [] }).success).toBe(false);
  });

  it('step_done map (research only) and plan-piece extension on a unit proposal', () => {
    const base = { stepId: ID, outcome: 'done', requirements: [], summary: 'mapped' };
    const map = {
      lines: ['core owns it'],
      files: [{ path: 'a.ts', why: 'entry' }],
      tests: [],
      owners: [],
    };
    expect(stepDoneSchema.safeParse({ ...base, map }).success).toBe(true);
    expect(stepDoneSchema.safeParse({ ...base, map: { ...map, lines: [] } }).success).toBe(false);
    expect(
      stepDoneSchema.safeParse({ ...base, map: { ...map, lines: Array(21).fill('x') } }).success,
    ).toBe(false);
    expect(STEP_DONE_KIND_FIELDS.map).toEqual(['research']);
    const unit = {
      name: 'u1',
      ownedPaths: ['a.ts'],
      role: 'mechanical',
      acRefs: [ID],
      inputs: [{ from: 'u0', iface: 'resolve()' }],
      spec: { files: ['a.ts'], check: 'unit' },
    };
    expect(stepDoneSchema.safeParse({ ...base, units: [unit] }).success).toBe(true);
    expect(stepDoneSchema.safeParse({ ...base, units: [{ ...unit, role: 'boss' }] }).success).toBe(
      false,
    );
  });

  it('estimate: intake source(s) and chat launch origin; structured AC only from tracker/group-item', () => {
    const fields = {
      title: 't',
      request: 'r',
      repos: [{ path: 'C:/work/p', baseRef: null }],
      scenario: { preset: 'chat' },
      launchPolicy: 'confirm',
      ciWait: false,
    };
    expect(estimateFieldsSchema.safeParse(fields).success).toBe(true);
    expect(estimateFieldsSchema.safeParse({ ...fields, source: SOURCE }).success).toBe(true);
    const tracker = { ...SOURCE, kind: 'tracker', key: 'PROJ-1', acceptance: ['AC 1'] };
    expect(estimateFieldsSchema.safeParse({ ...fields, sources: [tracker, SOURCE] }).success).toBe(
      true,
    );
    expect(
      estimateFieldsSchema.safeParse({ ...fields, source: { ...SOURCE, acceptance: ['AC'] } })
        .success,
    ).toBe(false);
    expect(
      estimateFieldsSchema.safeParse({ ...fields, source: { ...tracker, key: undefined } }).success,
    ).toBe(false);
    expect(estimateFieldsSchema.safeParse({ ...fields, sources: [] }).success).toBe(false);
    expect(
      estimateFieldsSchema.safeParse({
        ...fields,
        launchOrigin: { kind: 'chat', conversationId: 'conv-1' },
      }).success,
    ).toBe(true);
  });

  it('estimate reply names the lead profile and class (P144) and the group of N tasks (D18)', () => {
    type Lead = NonNullable<EstimateReply['lead']>;
    expectTypeOf<Lead['profile']>().toEqualTypeOf<'economy' | 'balanced' | 'max-quality'>();
    expectTypeOf<Lead['class']>().toEqualTypeOf<'S' | 'M' | 'L' | 'XL' | null>();
    expectTypeOf<Lead['warnings'][number]['cap']>().toEqualTypeOf<'queue.sessionSlots'>();
    expectTypeOf<NonNullable<EstimateReply['group']>['taskIds']>().toEqualTypeOf<string[]>();
    // Аренда до `openSession` (D9): у держателя места сеанса ещё может не быть.
    expectTypeOf<NonNullable<SessionTicket['holder']>['sessionId']>().toEqualTypeOf<
      string | null
    >();
    expect(
      taskViewSchema.shape.parentTaskId.safeParse('01920000-0000-7000-8000-00000000b012').success,
    ).toBe(true);
    expect(taskViewSchema.shape.parentTaskId.safeParse('parent-1').success).toBe(false);
  });

  it('decision classes intake and classify read their outcome from verdict and class', () => {
    expect(DECISION_CLASS_IDS).toEqual(expect.arrayContaining(['intake', 'classify']));
    expect(DECISION_OUTCOMES.intake).toEqual(['auto', 'ask']);
    expect(DECISION_OUTCOMES.classify).toEqual(['S', 'M', 'L', 'XL']);
    expect(decisionOutcome('intake', { verdict: 'ask' })).toBe('ask');
    expect(decisionOutcome('classify', { class: 'XL' })).toBe('XL');
    expect(decisionOutcome('classify', { class: 'XXL' })).toBeNull();
    expectTypeOf<IntakeDecision['verdict']>().toEqualTypeOf<'auto' | 'ask'>();
    expectTypeOf<TaskClassDecision['class']>().toEqualTypeOf<'S' | 'M' | 'L' | 'XL'>();
    // Модель понижать не может: отказ назван в решении (W2-8), а не потерян.
    expectTypeOf<TaskClassDecision['refusedLower']>().toEqualTypeOf<{
      proposed: 'S' | 'M' | 'L' | 'XL';
    } | null>();
  });

  it('learned-reset: a machine body with the learned key and a proof; strict', () => {
    const body = {
      cmdId: ID,
      key: {
        project: 'C:/work/p',
        stepKind: 'work',
        adapter: 'claude',
        route: 'claude-sub',
        model: null,
        role: 'review',
      },
      proof: { nonce: 'n1', page: ID2 },
    };
    expect(learnedResetBodySchema.safeParse(body).success).toBe(true);
    const key = (k: Record<string, unknown>) =>
      learnedResetBodySchema.safeParse({ ...body, key: { ...body.key, ...k } }).success;
    expect(key({ role: undefined })).toBe(true);
    expect(key({ role: 'boss' })).toBe(false);
    expect(key({ extra: 1 })).toBe(false);
    // Ключ машины, а не конверт задачи: `target`/`taskId` — ошибка вызывающего.
    expect(learnedResetBodySchema.safeParse({ ...body, target: { taskId: ID } }).success).toBe(
      false,
    );
  });

  it('agents: query filters and the eight panel routes', async () => {
    const { agentsQuerySchema, bgItemSchema } = await import('@agentdeck/contracts/core/agents');
    expect(
      agentsQuerySchema.safeParse({ status: 'running', class: 'L', groupId: 'g' }).success,
    ).toBe(true);
    expect(agentsQuerySchema.safeParse({ status: 'exit' }).success).toBe(false);
    expect(agentsQuerySchema.safeParse({ owner: 'x' }).success).toBe(false);
    expect(
      bgItemSchema.safeParse({
        itemId: 'b',
        kind: 'server',
        excerpt: '',
        ownerChain: OWNER,
        startedAt: 1,
      }).success,
    ).toBe(true);
    const paths = CORE_PANEL_ROUTES.map((r) => `${r.method} ${r.path}${'stream' in r ? ' ~' : ''}`);
    expect(paths).toEqual(
      expect.arrayContaining([
        'GET /tasks/:id/agents',
        'GET /tasks/:id/agents/:nodeId',
        'GET /tasks/:id/agents/stream ~',
        'GET /tasks/:id/agents/export',
        'GET /agents',
        'GET /allocator',
        'GET /local/activity',
        'GET /local/activity/stream ~',
      ]),
    );
  });

  it('intake source: tracker needs a key; body capped at 64k', async () => {
    const { intakeSourceSchema, INTAKE_BODY_MAX } =
      await import('@agentdeck/contracts/core/intake');
    expect(intakeSourceSchema.safeParse(SOURCE).success).toBe(true);
    expect(
      intakeSourceSchema.safeParse({ ...SOURCE, body: 'x'.repeat(INTAKE_BODY_MAX + 1) }).success,
    ).toBe(false);
    expect(intakeSourceSchema.safeParse({ ...SOURCE, kind: 'tracker' }).success).toBe(false);
    expect(intakeSourceSchema.safeParse({ ...SOURCE, kind: 'mail' }).success).toBe(false);
  });
});
