import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Scenario } from '@agentdeck/contracts/core/scenario';
import { claudeTranscriptPresent } from '../../adapters/claude/transcript.ts';
import { decideRouting } from '../../conductor/scenario/index.ts';
import { WindowBook } from '../../economy/window/index.ts';
import { presetStep } from '../../conductor/scenario/presets.ts';
import { ROUTE, stand, type Stand } from '../../conductor/run/__fixtures__/run-harness.ts';
import type { BriefSection, StepCtx } from '../../conductor/run/run.types.ts';
import { readJournalLines } from '../../journal/read-lines.ts';
import { newId } from '../../lib/ids/uuidv7.ts';
import { allowedOf } from '../session-road/compat-gate.ts';
import { createContextWiring } from './context.ts';
import { continuationFacts, conversationOf, createRunEconomy } from './continuation.ts';

/**
 * Порт экономики исполнителя поверх настоящих судей: книга окон L, бриф/дельта C, прогрев E — на
 * настоящем журнале стенда. Подделаны только сессия модели и часы.
 */

const WORK: Scenario = {
  id: 'w',
  version: 1,
  title: 't',
  steps: [presetStep('work', 'work', 'Работа', [])],
};

const parts = (handoff: string): BriefSection[] => [
  { id: 'task', text: 'Сделать экспорт отчёта в CSV.', from: 'test' },
  { id: 'step', text: 'Шаг работы: правка и тесты.', from: 'test' },
  { id: 'handoff', text: handoff, from: 'test' },
];

/** Строка запуска продолжения: новая сессия ядра, тот же разговор модели (`resumeOf`). */
function resumed(s: Stand, stepId: string, of: string): string {
  const sessionId = newId();
  s.task.append({
    kind: 'session.started',
    actor: 'core',
    stepId,
    sessionId,
    data: {
      sessionId,
      stepId,
      adapter: 'claude',
      cliVersion: '1',
      route: ROUTE.route,
      hops: [],
      credentialKind: 'none',
      modelAsked: null,
      modelServed: null,
      effort: null,
      hostPid: process.pid,
      hostStart: `start-${process.pid}`,
      cliPid: null,
      cliStart: null,
      cwd: '/w',
      argv: [],
      resumeOf: of,
      cacheAgeMs: 1000,
    },
  });
  return sessionId;
}

describe('economy wiring: the executor port (stage 5 W)', () => {
  it('continuation resume with delta: a resumed session gets only what changed since the conversation root; unchanged → nothing', async () => {
    const homeRoot = mkdtempSync(join(tmpdir(), 'w-econ-'));
    const econ = createRunEconomy({
      windows: new WindowBook(),
      now: () => Date.now(),
      context: createContextWiring({ homeRoot }),
    });
    const s = await stand(WORK, { model: { 'work:0': 'hold' }, journalSessions: true });
    await s.until(() => s.port.sessions.size === 1);
    const [stepId] = Object.keys(s.task.state.steps);
    const first = [...s.port.sessions.keys()][0]!;
    const ctx = { stepId, def: WORK.steps[0], round: 0 } as unknown as StepCtx;
    const brief = await econ.opening!(s.task, ctx, first, parts('Передача: начать с модели.'));
    expect(brief).toContain('Сделать экспорт отчёта в CSV.');
    const second = resumed(s, stepId!, first);
    const third = resumed(s, stepId!, second);
    expect(conversationOf([], third)).toBe(third);
    // Тот же набор — у модели уже всё: ни брифа, ни дельты.
    expect(await econ.opening!(s.task, ctx, third, parts('Передача: начать с модели.'))).toBeNull();
    // Изменилась одна секция — уходит только она.
    const delta = await econ.opening!(
      s.task,
      ctx,
      third,
      parts('Передача: тесты красные, чинить.'),
    );
    expect(delta).toContain('Передача: тесты красные, чинить.');
    expect(delta).not.toContain('Сделать экспорт отчёта в CSV.');
    await s.stop();
  });

  it('windows and routing env come from the one window book: an exhausted route is judged on every allowed route', async () => {
    const book = new WindowBook();
    const now = 1_000_000;
    book.observe({
      routeId: ROUTE.route.id,
      limitKind: 'budget',
      usedPct: null,
      resetAt: null,
      refusal: true,
      source: 'refusal',
      at: now - 10,
    });
    const econ = createRunEconomy({ windows: book, now: () => now });
    expect(econ.windows(ROUTE.route.id).map((d) => d.verdict)).toEqual(['exhausted']);
    const s = await stand(WORK, { model: { 'work:0': 'hold' } });
    const env = econ.routingEnv!(s.task);
    expect(env.windows?.map((d) => `${d.routeId}=${d.verdict}`)).toEqual([
      `${ROUTE.route.id}=exhausted`,
    ]);
    await s.stop();
  });

  it('allowed routes are read through allowedRoutesOf: a routes.set line of set-route replaces task.created for the window judge', async () => {
    const book = new WindowBook();
    const now = 1_000_000;
    const other = { ...ROUTE, route: { kind: 'stub' as const, id: 'stub:other' } };
    book.observe({
      routeId: other.route.id,
      limitKind: 'budget',
      usedPct: null,
      resetAt: null,
      refusal: true,
      source: 'refusal',
      at: now - 10,
    });
    const econ = createRunEconomy({ windows: book, now: () => now });
    const s = await stand(WORK, { model: { 'work:0': 'hold' } });
    expect(econ.routingEnv!(s.task).windows).toEqual([]);
    s.task.append({
      kind: 'routes.set',
      actor: 'core',
      data: { cmdId: newId(), allowedRoutes: [ROUTE, other], widened: [other] },
    });
    expect(econ.routingEnv!(s.task).windows?.map((d) => `${d.routeId}=${d.verdict}`)).toEqual([
      'stub:other=exhausted',
    ]);
    await s.stop();
  });

  it('tier and the compat gate judge the set of the last routes.set, not task.created', async () => {
    const s = await stand(WORK, { model: { 'work:0': 'hold' } });
    const other = { ...ROUTE, route: { kind: 'stub' as const, id: 'stub:narrowed' } };
    const step = { stepId: null, unitId: null, def: WORK.steps[0]! };
    expect(allowedOf(s.task).map((t) => t.route)).toEqual([ROUTE.route.id]);
    s.task.append({
      kind: 'routes.set',
      actor: 'core',
      data: { cmdId: newId(), allowedRoutes: [other], widened: [other] },
    });
    expect(decideRouting(s.task.state, step).tier).toMatchObject({
      ok: true,
      route: { id: 'stub:narrowed' },
    });
    expect(allowedOf(s.task).map((t) => t.route)).toEqual(['stub:narrowed']);
    await s.stop();
  });

  it('same-session on the real loop: an ended session of the step continues only when its Claude transcript is on disk', async () => {
    const config = mkdtempSync(join(tmpdir(), 'w-transcript-'));
    const pin = { CLAUDE_CONFIG_DIR: config };
    const econ = createRunEconomy({
      windows: new WindowBook(),
      now: () => Date.now(),
      resumes: () => true,
      transcriptPresent: (adapter, conv) =>
        adapter === 'claude' ? claudeTranscriptPresent(pin, conv) : undefined,
    });
    const s = await stand(WORK, { model: { 'work:0': 'hold' }, journalSessions: true });
    await s.until(() => s.port.sessions.size === 1);
    const [stepId] = Object.keys(s.task.state.steps);
    const sessionId = [...s.port.sessions.keys()][0]!;
    s.task.append({
      kind: 'session.transition',
      actor: 'core',
      sessionId,
      data: { sessionId, event: 'exited', from: 'live', to: 'ended' },
    });
    const step = {
      stepId: stepId!,
      unitId: s.task.state.steps[stepId!]!.unitId,
      def: WORK.steps[0]!,
    };
    const judge = () => decideRouting(s.task.state, step, econ.routingEnv!(s.task)).continuation;
    // Транскрипта нет — продолжать нечем: новый сеанс.
    expect(judge()).toMatchObject({ mode: 'fresh' });
    mkdirSync(join(config, 'projects', 'C--w'), { recursive: true });
    writeFileSync(join(config, 'projects', 'C--w', `${sessionId}.jsonl`), '{}\n');
    expect(judge()).toMatchObject({ mode: 'same-session', sessionId });
    await s.stop();
  });

  it('a review step gets the unit review pack after its brief; the same pack is not re-sent to that conversation', async () => {
    const homeRoot = mkdtempSync(join(tmpdir(), 'w-pack-'));
    const secret = 'session-env-secret-value-42';
    const econ = createRunEconomy({
      windows: new WindowBook(),
      now: () => Date.now(),
      context: createContextWiring({ homeRoot }),
      known: () => [secret],
      reviewPack: async (_task, unitId) => ({
        unitId,
        baseRef: 'a'.repeat(40),
        files: [
          { path: 'src/a.ts', added: 1, deleted: 1, binary: false, diff: `-one\n+${secret}\n` },
        ],
        requirements: [],
        records: [],
      }),
    });
    const s = await stand(WORK, { model: { 'work:0': 'hold' }, journalSessions: true });
    await s.until(() => s.port.sessions.size === 1);
    const [stepId] = Object.keys(s.task.state.steps);
    const sessionId = [...s.port.sessions.keys()][0]!;
    const unitId = s.task.state.steps[stepId!]!.unitId;
    const review = { stepId, unitId, def: { ...WORK.steps[0], kind: 'review' }, round: 0 };
    const ctx = review as unknown as StepCtx;
    const first = await econ.opening!(s.task, ctx, sessionId, parts('Передача: судить правку.'));
    expect(first).toContain('Сделать экспорт отчёта в CSV.');
    expect(first).toContain('# Review pack');
    expect(first).toContain('+••••••');
    expect(first).not.toContain(secret);
    // Шаг работы пакета не получает.
    const work = { ...review, def: WORK.steps[0] } as unknown as StepCtx;
    expect(await econ.opening!(s.task, work, newId(), parts('x'))).not.toContain('# Review pack');
    expect(
      await econ.opening!(s.task, ctx, sessionId, parts('Передача: судить правку.')),
    ).toBeNull();
    await s.stop();
  });

  it('G8 keep-warm judge input: a parked session on an open route past 50 of 60 min is pinged once per retry, counted per wait', async () => {
    let now = 0;
    const book = new WindowBook();
    const econ = createRunEconomy({ windows: book, now: () => now, resumes: () => true });
    const s = await stand(WORK, { model: { 'work:0': 'hold' }, journalSessions: true });
    await s.until(() => s.port.sessions.size === 1);
    const [stepId] = Object.keys(s.task.state.steps);
    const sessionId = [...s.port.sessions.keys()][0]!;
    s.port.usage(stepId!, { input: 2_000, output: 100, cacheWrite: 40_000, cacheWrite1h: 40_000 });
    const at = s.task.state.seq;
    const line = readJournalLines(s.dir, s.taskId).lines.find((l) => l.seq === at)!;
    const idle = { sessionId, stepId: stepId!, turnSeq: at, parked: true };
    now = line.at + 51 * 60_000;
    // Фактов окна маршрута нет — «открыто» не выдумывается: пинга нет.
    expect(econ.keepWarm!(s.task, [idle])).toEqual([]);
    book.observe({
      routeId: ROUTE.route.id,
      limitKind: 'window',
      usedPct: 10,
      resetAt: null,
      refusal: false,
      source: 'cli-event',
      at: now,
    });
    expect(econ.keepWarm!(s.task, [{ ...idle, parked: false }])).toEqual([]);
    now = line.at + 10 * 60_000;
    expect(econ.keepWarm!(s.task, [idle])).toEqual([]);
    now = line.at + 51 * 60_000;
    const pinged = econ.keepWarm!(s.task, [idle]);
    expect(pinged.map((p) => p.sessionId)).toEqual([sessionId]);
    expect(pinged[0]!.numbers).toMatchObject({ pings: 0, ttlMs: 3_600_000 });
    // Пинг этого ожидания уже был: сразу второй — нет (повтор не раньше срока судьи E).
    expect(econ.keepWarm!(s.task, [idle])).toEqual([]);
    now += 6 * 60_000;
    expect(econ.keepWarm!(s.task, [idle])[0]?.numbers.pings).toBe(1);
    // Новый ход шага — новое ожидание: счёт пингов и срок повтора с нуля.
    expect(econ.keepWarm!(s.task, [{ ...idle, turnSeq: at + 1 }])[0]?.numbers.pings).toBe(0);
    await s.stop();
  });

  it('stage 8 windowTokens: the 60 % rule reads the window of the route × model of the last MAIN turn from the one window book; none → null', async () => {
    const asked: string[] = [];
    const windowOf = (routeId: string, model: string | null) => {
      asked.push(`${routeId}/${String(model)}`);
      return model === 'big-model' ? 1_000_000 : 200_000;
    };
    const s = await stand(WORK, { model: { 'work:0': 'hold' }, journalSessions: true });
    await s.until(() => s.port.sessions.size === 1);
    const sessionId = [...s.port.sessions.keys()][0]!;
    const rec = s.task.state.sessions[sessionId]!;
    const candidate = {
      sessionId,
      stepDefId: 'work',
      state: rec.state,
      adapter: rec.adapter,
      route: rec.route,
      startedSeq: 1,
    };
    const facts = () =>
      continuationFacts(s.task, readJournalLines(s.dir, s.taskId).lines, candidate, 0, windowOf);
    // Ходов ещё нет — модели нет, окно не спрашивается.
    expect(facts().windowTokens).toBeNull();
    expect(asked).toEqual([]);
    const usage = (messageId: string, model: string, over: Record<string, unknown> = {}) =>
      s.task.append({
        kind: 'turn.usage',
        actor: `session:${sessionId}`,
        sessionId,
        data: {
          sessionId,
          messageId,
          input: 10,
          cacheRead: 0,
          cacheWrite: 0,
          cacheWrite1h: 0,
          output: 1,
          routeId: 'route-a',
          model,
          subagent: false,
          parentSessionId: null,
          remainder: false,
          ...over,
        },
      });
    usage('m1', 'small-model');
    usage('m2', 'big-model');
    expect(facts().windowTokens).toBe(1_000_000);
    // Near-miss: ход подагента и строка-остаток модель основной сессии не сдвигают.
    usage('m3', 'small-model', { subagent: true, parentSessionId: sessionId });
    usage('m4', 'small-model', { remainder: true });
    expect(facts().windowTokens).toBe(1_000_000);
    expect(asked.at(-1)).toBe('route-a/big-model');
    // Книги окон нет — правило не судит.
    expect(
      continuationFacts(s.task, readJournalLines(s.dir, s.taskId).lines, candidate, 0).windowTokens,
    ).toBeNull();
    // Сессия назвала окно сама (вход CLI): книга молчит — судит названное; книга знает — она главнее.
    usage('m5', 'big-model', { contextWindow: 64_000 });
    const lines = () => readJournalLines(s.dir, s.taskId).lines;
    expect(continuationFacts(s.task, lines(), candidate, 0, () => null).windowTokens).toBe(64_000);
    expect(continuationFacts(s.task, lines(), candidate, 0).windowTokens).toBe(64_000);
    expect(facts().windowTokens).toBe(1_000_000);
    await s.stop();
  });
});
