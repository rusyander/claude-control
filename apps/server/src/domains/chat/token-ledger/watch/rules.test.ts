import { describe, expect, it } from 'vitest';
import { GROUP_WATCH_DEFAULTS, type GroupWatch } from '@agentdeck/contracts/group-watch';
import { createWatchState, isSleepPoll, normPath, reduce } from './reduce.ts';
import {
  EVENT_HOLD_MS,
  GROUP_LEVEL,
  GROUP_SCOPED_RULES,
  SESSION_RULES,
  SINGLE_RULES,
  accountProjection,
  evaluate,
  groupBurn,
} from './rules.ts';
import type { WatchContext, WatchEvent, WatchNode } from './watch.types.ts';

const MIN = 60_000;
const T0 = Date.parse('2026-10-20T10:00:00Z');

interface Run {
  events: WatchEvent[];
  node?: Partial<WatchNode>;
  settings?: Partial<GroupWatch>;
  ctx?: Partial<WatchContext>;
  now: number;
}

function hits({ events, node, settings, ctx, now }: Run) {
  const context: WatchContext = { settings: { ...GROUP_WATCH_DEFAULTS, ...settings }, ...ctx };
  const state = createWatchState(T0);
  for (const event of events) reduce(state, event, context);
  return evaluate(
    state,
    { chatId: 'c1', groupIndex: 0, running: true, paused: false, ...node },
    context,
    now,
  );
}

const rules = (run: Run): string[] => hits(run).map((hit) => hit.rule);

const call = (
  t: number,
  over: Partial<Extract<WatchEvent, { kind: 'call' }>> = {},
): WatchEvent => ({
  kind: 'call',
  t,
  input: 10,
  cacheRead: 50_000,
  cacheWrite: 1_000,
  cacheWrite1h: 1_000,
  output: 200,
  // Opus 4.5+ — множитель 5 (старые Opus 4/4.1 — 15, F-65).
  model: 'claude-opus-4-8',
  ...over,
});
const bash = (t: number, command: string, id = `b${t}`, stage?: string): WatchEvent => ({
  kind: 'tool',
  t,
  id,
  name: 'Bash',
  input: { command },
  ...(stage ? { stage } : {}),
});
const tool = (
  t: number,
  name: string,
  input: Record<string, unknown>,
  stage?: string,
): WatchEvent => ({
  kind: 'tool',
  t,
  id: `${name}${t}`,
  name,
  input,
  ...(stage ? { stage } : {}),
});
const done = (t: number, id: string): WatchEvent => ({ kind: 'toolResult', t, id, chars: 10 });

describe('group watch rules', () => {
  it('R1 fires on silence past the threshold and stays silent for legitimate waits', () => {
    const events = [{ kind: 'start', t: T0 } as WatchEvent, call(T0 + MIN)];
    const stalled = hits({ events, now: T0 + 22 * MIN }).find((hit) => hit.rule === 'R1');
    expect(stalled?.numbers).toEqual({ idleMin: 21 });
    expect(rules({ events, now: T0 + 20 * MIN })).not.toContain('R1');
    expect(rules({ events, node: { paused: true }, now: T0 + 40 * MIN })).not.toContain('R1');
    expect(rules({ events, node: { running: false }, now: T0 + 40 * MIN })).not.toContain('R1');
    expect(rules({ events, node: { heavyLease: true }, now: T0 + 40 * MIN })).not.toContain('R1');
    const longBash = [
      ...events,
      tool(T0 + 2 * MIN, 'Bash', { command: 'pnpm gate', timeout: 45 * MIN }),
    ];
    expect(rules({ events: longBash, now: T0 + 30 * MIN })).not.toContain('R1');
    expect(rules({ events: longBash, now: T0 + 50 * MIN })).toContain('R1');
    const ended = [...events, { kind: 'end', t: T0 + 2 * MIN } as WatchEvent];
    expect(rules({ events: ended, now: T0 + 60 * MIN })).not.toContain('R1');
    expect(rules({ events, settings: { stallMinutes: 30 }, now: T0 + 25 * MIN })).not.toContain(
      'R1',
    );
  });

  it('R1b fires on an unanswered question, from the tool call or the panel record', () => {
    const asked = [
      { kind: 'start', t: T0 } as WatchEvent,
      tool(T0, 'AskUserQuestion', { questions: [{ question: 'Which branch?' }] }),
    ];
    const hit = hits({ events: asked, now: T0 + 16 * MIN }).find((h) => h.rule === 'R1b');
    expect(hit?.numbers).toEqual({ waitMin: 16 });
    expect(hit?.params).toEqual({ question: 'Which branch?' });
    expect(rules({ events: asked, now: T0 + 14 * MIN })).not.toContain('R1b');
    // Вопрос открыт — молчание его, а не зависание.
    expect(rules({ events: asked, now: T0 + 40 * MIN })).not.toContain('R1');
    const fromPanel = rules({
      events: [{ kind: 'start', t: T0 }],
      node: { ask: { since: T0 } },
      now: T0 + 20 * MIN,
    });
    expect(fromPanel).toContain('R1b');
  });

  it('R1b turns from warn to alert once the question waits askAlertMinutes (C02)', () => {
    const run = (waitMin: number, settings?: Partial<GroupWatch>) =>
      hits({
        events: [{ kind: 'start', t: T0 }],
        node: { ask: { since: T0 } },
        settings,
        now: T0 + waitMin * MIN,
      }).find((hit) => hit.rule === 'R1b')?.severity;
    expect(run(59)).toBe('warn');
    expect(run(60)).toBe('alert');
    expect(run(253)).toBe('alert');
    expect(run(60, { askAlertMinutes: 120 })).toBe('warn');
  });

  it('chat scope evaluates only the single-chat rules; group-level rules never come from a session', () => {
    // Вопрос (R1b) и пуш при доставке впереди (R6) — правила звена группы, не одиночного чата.
    const events: WatchEvent[] = [
      { kind: 'start', t: T0 },
      bash(T0, 'git push', 'p', 'work'),
      done(T0 + 1000, 'p'),
      bash(T0 + 2000, 'until [ -f out/done ]; do sleep 20; done'),
    ];
    const run = { events, node: { deliverAhead: true, ask: { since: T0 } }, now: T0 + 20 * MIN };
    const context: WatchContext = { settings: GROUP_WATCH_DEFAULTS };
    const state = createWatchState(T0);
    for (const event of run.events) reduce(state, event, context);
    const node: WatchNode = {
      chatId: 'c1',
      groupIndex: -1,
      running: true,
      paused: false,
      ...run.node,
    };
    const group = evaluate(state, node, context, run.now).map((hit) => hit.rule);
    const chat = evaluate(state, node, context, run.now, 'chat').map((hit) => hit.rule);
    expect(group).toEqual(expect.arrayContaining(['R1b', 'R6', 'R11']));
    expect(chat).toContain('R11');
    expect(chat).not.toContain('R1b');
    expect(chat).not.toContain('R6');
    for (const rule of chat) expect(SINGLE_RULES.has(rule)).toBe(true);
    for (const rule of ['R22', 'R23', 'R28'] as const) {
      expect(GROUP_LEVEL.has(rule)).toBe(true);
      expect(GROUP_SCOPED_RULES.has(rule)).toBe(true);
      expect(SESSION_RULES.has(rule)).toBe(false);
    }
    // Пауза группы у одиночного чата не действует: его правила считаются как обычно.
    expect(
      evaluate(state, { ...node, paused: true }, context, run.now, 'chat').map((hit) => hit.rule),
    ).toContain('R11');
  });

  it('R2 fires on a cold rewrite after a long pause, not on a warm continuation', () => {
    const first = [
      { kind: 'start', t: T0 } as WatchEvent,
      call(T0, { cacheRead: 0, cacheWrite: 100_000 }),
    ];
    const cold = [
      ...first,
      { kind: 'end', t: T0 + MIN } as WatchEvent,
      { kind: 'start', t: T0 + 61 * MIN } as WatchEvent,
      call(T0 + 61 * MIN, { cacheRead: 0, cacheWrite: 100_000, cacheWrite1h: 100_000 }),
    ];
    const hit = hits({ events: cold, now: T0 + 62 * MIN }).find((h) => h.rule === 'R2');
    expect(hit?.numbers).toEqual({ writeK: 100, gapMin: 61, lostW: 0.95 });
    const warm = [
      ...first,
      { kind: 'start', t: T0 + 10 * MIN } as WatchEvent,
      call(T0 + 10 * MIN, { cacheRead: 100_000, cacheWrite: 500 }),
    ];
    expect(rules({ events: warm, now: T0 + 11 * MIN })).not.toContain('R2');
    // Правило-событие закрывается само через полчаса.
    expect(rules({ events: cold, now: T0 + 61 * MIN + EVENT_HOLD_MS + MIN })).not.toContain('R2');
  });

  it('R3 fires on two compactions closer than the threshold', () => {
    const storm = [
      { kind: 'compact', t: T0 } as WatchEvent,
      { kind: 'compact', t: T0 + 10 * MIN } as WatchEvent,
    ];
    expect(
      hits({ events: storm, now: T0 + 11 * MIN }).find((h) => h.rule === 'R3')?.numbers,
    ).toEqual({
      gapMin: 10,
      count: 2,
    });
    const calm = [
      { kind: 'compact', t: T0 } as WatchEvent,
      { kind: 'compact', t: T0 + 20 * MIN } as WatchEvent,
    ];
    expect(rules({ events: calm, now: T0 + 21 * MIN })).not.toContain('R3');
  });

  // F-73: порог владельца — граница «строго дольше / строго ближе»; сдвиг на
  // знак сравнения меняет, что человек видит на ровном пороге.
  it('R1 and R3 at the threshold: silence of exactly 20 min and compactions 15 min apart are quiet', () => {
    const events = [{ kind: 'start', t: T0 } as WatchEvent, call(T0 + MIN)];
    expect(rules({ events, now: T0 + MIN + 19 * MIN })).not.toContain('R1');
    expect(rules({ events, now: T0 + MIN + 20 * MIN })).not.toContain('R1');
    expect(rules({ events, now: T0 + MIN + 21 * MIN })).toContain('R1');
    const pair = (gapMin: number): WatchEvent[] => [
      { kind: 'compact', t: T0 } as WatchEvent,
      { kind: 'compact', t: T0 + gapMin * MIN } as WatchEvent,
    ];
    expect(rules({ events: pair(14), now: T0 + 15 * MIN })).toContain('R3');
    expect(rules({ events: pair(15), now: T0 + 16 * MIN })).not.toContain('R3');
    expect(rules({ events: pair(16), now: T0 + 17 * MIN })).not.toContain('R3');
  });

  // F-39: заводской порог R4 — 3 повтора (рамка); живая проверка ставит 2 явно, это не заводское.
  it('the factory R4 threshold is 3 repeats', () => {
    expect(GROUP_WATCH_DEFAULTS.checkRepeats).toBe(3);
  });

  it('R4 fires on the same check three times with no edit between', () => {
    const same = [1, 2, 3].map((n) => bash(T0 + n * MIN, 'npx vitest run src/a.test.ts'));
    const hit = hits({ events: same, now: T0 + 4 * MIN }).find((h) => h.rule === 'R4');
    expect(hit?.numbers).toEqual({ runs: 3 });
    expect(hit?.params?.command).toBe('npx vitest run src/a.test.ts');
    const edited = [
      same[0]!,
      same[1]!,
      tool(T0 + 2.5 * MIN, 'Edit', { file_path: '/w/a.ts' }),
      same[2]!,
    ];
    expect(rules({ events: edited, now: T0 + 4 * MIN })).not.toContain('R4');
    const different = ['a', 'b', 'c'].map((f, n) =>
      bash(T0 + n * MIN, `npx vitest run src/${f}.test.ts`),
    );
    expect(rules({ events: different, now: T0 + 4 * MIN })).not.toContain('R4');
    const notCheck = [1, 2, 3].map((n) => bash(T0 + n * MIN, 'git status'));
    expect(rules({ events: notCheck, now: T0 + 4 * MIN })).not.toContain('R4');
  });

  it('R5 fires on a review spawn during the work stage only', () => {
    const spawn = (stage: string) => [
      tool(
        T0,
        'Task',
        { description: 'deep-review r1 lane A', subagent_type: 'general-purpose' },
        stage,
      ),
    ];
    expect(rules({ events: spawn('work'), now: T0 + MIN })).toContain('R5');
    expect(rules({ events: spawn('review'), now: T0 + MIN })).not.toContain('R5');
  });

  it('R6 fires on push or MR in work/review only while a deliver stage is ahead', () => {
    const ahead = { deliverAhead: true };
    // Повод — исполненный вызов: ответ пришёл и он не отказ (C17).
    const r6 = (command: string, stage = 'work', node: Partial<WatchNode> = ahead) =>
      rules({
        events: [bash(T0, command, 'p', stage), done(T0 + 1000, 'p')],
        node,
        now: T0 + MIN,
      }).includes('R6');
    expect(r6('git push -u origin HEAD')).toBe(true);
    expect(r6('glab mr create --fill', 'review')).toBe(true);
    expect(r6('gh pr create --fill')).toBe(true);
    // Глобальные ключи git до подкоманды — всё тот же пуш.
    expect(r6('git -C "/work/my copy" push')).toBe(true);
    expect(r6('git -c core.askPass=x --no-pager push origin HEAD')).toBe(true);
    expect(r6('pnpm lint && git push')).toBe(true);
    // Коммит — своя работа звена; упоминание команды в тексте — не публикация.
    expect(r6('git commit -m "x"')).toBe(false);
    expect(r6('echo "git push origin" >> notes.md')).toBe(false);
    expect(r6("grep -n 'gh pr create' docs/*.md")).toBe(false);
    expect(r6('git log --grep=push')).toBe(false);
    // Доставка, звено без доставки впереди и давний повод — тишина.
    expect(r6('git push', 'deliver')).toBe(false);
    expect(r6('git push', 'work', {})).toBe(false);
    expect(
      rules({
        events: [bash(T0, 'git push', 'p', 'work'), done(T0 + 1000, 'p')],
        node: ahead,
        now: T0 + EVENT_HOLD_MS + 2 * MIN,
      }),
    ).not.toContain('R6');
    // MR через MCP — тоже публикация.
    const mcpId = `mcp__forge__create_merge_request${T0}`;
    expect(
      rules({
        events: [tool(T0, 'mcp__forge__create_merge_request', {}, 'work'), done(T0 + 1, mcpId)],
        node: ahead,
        now: T0 + MIN,
      }),
    ).toContain('R6');
  });

  it('R6 counts only an executed publish: a denied push or one without a result is not one (C17)', () => {
    const denied: WatchEvent = {
      kind: 'toolResult',
      t: T0 + 1000,
      id: 'p',
      chars: 40,
      denied: 'permission-rule',
    };
    const node = { deliverAhead: true };
    expect(
      rules({ events: [bash(T0, 'git push', 'p', 'work'), denied], node, now: T0 + MIN }),
    ).not.toContain('R6');
    expect(
      rules({ events: [bash(T0, 'git push', 'p', 'work')], node, now: T0 + MIN }),
    ).not.toContain('R6');
    // Отбит, затем исполнен повтором — один исполненный пуш.
    const pushed = hits({
      events: [
        bash(T0, 'git push', 'p', 'work'),
        denied,
        bash(T0 + 2 * MIN, 'git push', 'p2', 'work'),
        done(T0 + 2 * MIN + 1000, 'p2'),
      ],
      node,
      now: T0 + 3 * MIN,
    }).find((hit) => hit.rule === 'R6');
    expect(pushed?.numbers).toEqual({ ops: 1 });
  });

  it('R7 fires on reads of the panel files from a copy, not on reads inside the copy', () => {
    const ctx = { panelRoot: '/work/panel', cwd: '/work/panel/.worktrees/g1' };
    const outside = [tool(T0, 'Read', { file_path: '/work/panel/apps/x.ts' })];
    expect(
      hits({ events: outside, ctx, now: T0 + MIN }).find((h) => h.rule === 'R7')?.params,
    ).toEqual({
      path: '/work/panel/apps/x.ts',
    });
    const inside = [tool(T0, 'Read', { file_path: '/work/panel/.worktrees/g1/apps/x.ts' })];
    expect(rules({ events: inside, ctx, now: T0 + MIN })).not.toContain('R7');
    const grep = [bash(T0, 'grep -rn foo /work/panel/apps/server')];
    expect(rules({ events: grep, ctx, now: T0 + MIN })).toContain('R7');
  });

  it('R8 (groupBurn) fires on a group burn rate above the threshold over a stream of calls', () => {
    // Opus 4.5+, 1M часовой записи: 5 × 2 = 10 W за вызов.
    const settings = { ...GROUP_WATCH_DEFAULTS };
    const heavy = [1, 2, 3].map((n) => ({ t: T0 + n * MIN, weight: 10 }));
    expect(groupBurn(heavy, settings, T0 + 5 * MIN)?.numbers).toEqual({ perHour: 120 });
    expect(groupBurn(heavy, settings, T0 + 5 * MIN)?.since).toBe(T0 + MIN);
    // Один-два тяжёлых вызова — не поток.
    expect(groupBurn(heavy.slice(0, 2), settings, T0 + 5 * MIN)).toBeUndefined();
    expect(groupBurn(heavy, { ...settings, burnPerHour: 150 }, T0 + 5 * MIN)).toBeUndefined();
    // Вызовы вне окна `burnMinutes` и из будущего не в счёт.
    const outside = [...heavy, { t: T0 + 60 * MIN, weight: 1000 }];
    expect(groupBurn(outside, settings, T0 + 5 * MIN)?.numbers).toEqual({ perHour: 120 });
    expect(groupBurn(heavy, settings, T0 + 3 * MIN + 31 * MIN)).toBeUndefined();
  });

  it('R9 (accountProjection) projects the five-hour window to its reset', () => {
    const settings = { ...GROUP_WATCH_DEFAULTS };
    const resetsAt = (T0 + 60 * MIN) / 1000;
    const rising = [
      { t: T0 + 10 * MIN, utilization: 0.6, resetsAt },
      { t: T0, utilization: 0.5, resetsAt },
    ];
    expect(accountProjection(rising, settings, T0 + 10 * MIN)?.numbers).toEqual({
      projectedPct: 110,
      nowPct: 60,
      resetMin: 50,
    });
    const flat = [
      { t: T0, utilization: 0.5, resetsAt },
      { t: T0 + 10 * MIN, utilization: 0.52, resetsAt },
    ];
    expect(accountProjection(flat, settings, T0 + 10 * MIN)).toBeUndefined();
    // Замеры другого окна (прежний сброс) в наклон не идут; меньше пяти минут — не тренд.
    const otherWindow = [
      { t: T0, utilization: 0.1, resetsAt: resetsAt - 18_000 },
      { t: T0 + 8 * MIN, utilization: 0.6, resetsAt },
      { t: T0 + 10 * MIN, utilization: 0.62, resetsAt },
    ];
    expect(accountProjection(otherWindow, settings, T0 + 10 * MIN)).toBeUndefined();
    expect(accountProjection([], settings, T0)).toBeUndefined();
  });

  it('session evaluate never raises the group-scoped R8/R9, however heavy the session', () => {
    const resetsAt = (T0 + 60 * MIN) / 1000;
    const heavy = [1, 2, 3].map((n) =>
      call(T0 + n * MIN, { cacheRead: 0, cacheWrite: 1_000_000, input: 0, output: 0 }),
    );
    const rising = [
      { kind: 'limit', t: T0, utilization: 0.5, resetsAt } as WatchEvent,
      { kind: 'limit', t: T0 + 10 * MIN, utilization: 0.6, resetsAt } as WatchEvent,
    ];
    const fired = rules({ events: [...heavy, ...rising], now: T0 + 10 * MIN });
    expect(fired).not.toContain('R8');
    expect(fired).not.toContain('R9');
  });

  it('R10 fires on a rejected limit and clears on the next call', () => {
    const rejected = [
      { kind: 'limit', t: T0, rejected: true, resetsAt: (T0 + 30 * MIN) / 1000 } as WatchEvent,
    ];
    expect(
      hits({ events: rejected, now: T0 + 10 * MIN }).find((h) => h.rule === 'R10')?.numbers,
    ).toEqual({
      resetMin: 20,
    });
    expect(rules({ events: [...rejected, call(T0 + 31 * MIN)], now: T0 + 32 * MIN })).not.toContain(
      'R10',
    );
  });

  it('R11 fires on a sleep-poll loop and ignores a plain sleep', () => {
    expect(isSleepPoll('while ! grep -q done out.log; do sleep 30; done')).toBe(true);
    expect(isSleepPoll('sleep 5')).toBe(false);
    expect(isSleepPoll('for f in a b; do echo $f; done')).toBe(false);
    const loop = [bash(T0, 'until [ -f out/done ]; do sleep 20; done')];
    expect(rules({ events: loop, now: T0 + MIN })).toContain('R11');
  });

  it('R11 needs the sleep inside the loop body: one pause after `done` is not a poll (C18)', () => {
    const killLoop =
      'for p in 1234 5678; do taskkill //F //PID $p; done; sleep 1; netstat -ano | grep :5173';
    expect(isSleepPoll(killLoop)).toBe(false);
    expect(rules({ events: [bash(T0, killLoop)], now: T0 + MIN })).not.toContain('R11');
    // Сон в теле цикла — опрос, и во вложенном цикле тоже.
    const seqLoop = 'for i in $(seq 1 170); do grep -q done out.log && break; sleep 10; done';
    expect(isSleepPoll(seqLoop)).toBe(true);
    expect(rules({ events: [bash(T0, seqLoop)], now: T0 + MIN })).toContain('R11');
    expect(
      isSleepPoll('for a in x; do for b in y; do cat $b.log; sleep 5; done; done; echo end'),
    ).toBe(true);
  });

  it('R12 fires on the same file read three times with no edit of it', () => {
    const read = (n: number, input: Record<string, unknown> = {}) =>
      tool(T0 + n * MIN, 'Read', { file_path: 'C:\\work\\app\\a.ts', ...input });
    const again = [read(1), read(2), read(3)];
    expect(
      hits({ events: again, now: T0 + 4 * MIN }).find((h) => h.rule === 'R12')?.numbers,
    ).toEqual({
      reads: 3,
    });
    expect(
      rules({
        events: [read(1), read(2, { offset: 100 }), read(3, { offset: 200 })],
        now: T0 + 4 * MIN,
      }),
    ).not.toContain('R12');
    const edited = [
      read(1),
      read(2),
      tool(T0 + 2.5 * MIN, 'Edit', { file_path: 'c:/work/app/a.ts' }),
      read(3),
    ];
    expect(rules({ events: edited, now: T0 + 4 * MIN })).not.toContain('R12');
  });

  it('subagent tool calls never count toward the session rules', () => {
    const side = [1, 2, 3].map((n) => ({
      ...bash(T0 + n * MIN, 'npx vitest run src/a.test.ts'),
      sidechain: true,
    }));
    expect(rules({ events: side, now: T0 + 4 * MIN })).not.toContain('R4');
  });

  it('a closed long call no longer excuses silence', () => {
    const closed = [
      { kind: 'start', t: T0 } as WatchEvent,
      bash(T0, 'pnpm gate', 'g1'),
      done(T0 + MIN, 'g1'),
    ];
    expect(rules({ events: closed, now: T0 + 25 * MIN })).toContain('R1');
  });

  it('an open subagent call excuses silence only up to twice the stall threshold', () => {
    const spawned = [
      { kind: 'start', t: T0 } as WatchEvent,
      tool(T0 + MIN, 'Task', { description: 'lane A', subagent_type: 'lane-high' }),
    ];
    expect(rules({ events: spawned, now: T0 + 30 * MIN })).not.toContain('R1');
    expect(rules({ events: spawned, now: T0 + 42 * MIN })).toContain('R1');
  });

  it('R2 prices the lost write by its own cache TTL split', () => {
    const cold = (cacheWrite1h: number) => [
      { kind: 'start', t: T0 } as WatchEvent,
      call(T0, { cacheRead: 0, cacheWrite: 100_000 }),
      { kind: 'end', t: T0 + MIN } as WatchEvent,
      { kind: 'start', t: T0 + 61 * MIN } as WatchEvent,
      call(T0 + 61 * MIN, { cacheRead: 0, cacheWrite: 100_000, cacheWrite1h }),
    ];
    const lost = (cacheWrite1h: number) =>
      hits({ events: cold(cacheWrite1h), now: T0 + 62 * MIN }).find((h) => h.rule === 'R2')?.numbers
        .lostW;
    expect(lost(100_000)).toBe(0.95);
    // Пятиминутная запись дешевле часовой (×1.25 против ×2): потеря меньше.
    expect(lost(0)).toBeCloseTo(0.575, 1);
  });

  it('R3 ignores a compaction the human asked for', () => {
    const asked = [
      { kind: 'compact', t: T0, manual: true } as WatchEvent,
      { kind: 'compact', t: T0 + 5 * MIN } as WatchEvent,
    ];
    expect(rules({ events: asked, now: T0 + 6 * MIN })).not.toContain('R3');
  });

  it('R4 keeps the cd directory, drops redirections, masks secrets', () => {
    const at = (n: number, command: string) => bash(T0 + n * MIN, command);
    const dirs = [
      at(1, 'cd apps/web && pnpm test'),
      at(2, 'cd apps/server && pnpm test'),
      at(3, 'cd apps/web && pnpm test'),
    ];
    expect(rules({ events: dirs, now: T0 + 4 * MIN })).not.toContain('R4');
    const redirected = [
      at(1, 'pnpm test'),
      at(2, 'pnpm test 2>&1 > out.log'),
      at(3, 'pnpm test &> out.log'),
    ];
    expect(rules({ events: redirected, now: T0 + 4 * MIN })).toContain('R4');
    const secret = [1, 2, 3].map((n) => at(n, 'API_TOKEN=s3cr3t pnpm test'));
    const hit = hits({ events: secret, now: T0 + 4 * MIN }).find((h) => h.rule === 'R4');
    expect(hit?.params?.command).toContain('API_TOKEN=***');
    expect(hit?.params?.command).not.toContain('s3cr3t');
  });

  it('a subagent edit or a tree-changing command resets checks and reads', () => {
    const run = (n: number) => bash(T0 + n * MIN, 'npx vitest run src/a.test.ts');
    const read = (n: number) => tool(T0 + n * MIN, 'Read', { file_path: '/w/a.ts' });
    const sideEdit = { ...tool(T0 + 2.5 * MIN, 'Edit', { file_path: '/w/a.ts' }), sidechain: true };
    expect(rules({ events: [run(1), run(2), sideEdit, run(3)], now: T0 + 4 * MIN })).not.toContain(
      'R4',
    );
    expect(
      rules({ events: [read(1), read(2), sideEdit, read(3)], now: T0 + 4 * MIN }),
    ).not.toContain('R12');
    for (const command of ['git checkout other', 'sed -i s/a/b/ src/a.ts', 'pnpm eslint . --fix']) {
      const tree = bash(T0 + 2.5 * MIN, command);
      expect(rules({ events: [run(1), run(2), tree, run(3)], now: T0 + 4 * MIN })).not.toContain(
        'R4',
      );
      expect(rules({ events: [read(1), read(2), tree, read(3)], now: T0 + 4 * MIN })).not.toContain(
        'R12',
      );
    }
    // Новая ветка на том же коммите и список тайника дерево не меняют.
    const branch = bash(T0 + 2.5 * MIN, 'git checkout -b next');
    expect(rules({ events: [run(1), run(2), branch, run(3)], now: T0 + 4 * MIN })).toContain('R4');
  });

  it('R12 treats offset 0 as a whole-file read', () => {
    const read = (n: number, input: Record<string, unknown> = {}) =>
      tool(T0 + n * MIN, 'Read', { file_path: '/w/a.ts', ...input });
    expect(
      rules({ events: [read(1), read(2, { offset: 0 }), read(3)], now: T0 + 4 * MIN }),
    ).toContain('R12');
  });

  it('bounds the reads and checks maps, evicting the oldest', () => {
    const context: WatchContext = { settings: GROUP_WATCH_DEFAULTS };
    const state = createWatchState(T0);
    for (let n = 0; n < 150; n += 1) {
      reduce(state, tool(T0 + n, 'Read', { file_path: `/work/f${n}.ts` }), context);
      reduce(state, bash(T0 + n, `npx vitest run src/f${n}.test.ts`), context);
    }
    expect(Object.keys(state.reads)).toHaveLength(100);
    expect(Object.keys(state.checks)).toHaveLength(100);
    expect(Object.keys(state.reads)).not.toContain('/work/f0.ts#:');
    expect(Object.keys(state.reads)).toContain('/work/f149.ts#:');
  });

  it('normPath folds Git Bash and case on Windows only, slashes everywhere', () => {
    expect(normPath('/c/Work/App/', 'win32')).toBe('c:/work/app');
    expect(normPath('C:\\Work\\App', 'win32')).toBe('c:/work/app');
    // На Linux и macOS `/home/User` и `/home/user` — разные каталоги, `/c/` — обычная папка.
    expect(normPath('/home/User/App/', 'linux')).toBe('/home/User/App');
    expect(normPath('/c/Work', 'darwin')).toBe('/c/Work');
  });

  it('R7 sees the bare panel root, paths relative to the copy, ~ and 8.3 short names', () => {
    const ctx = {
      panelRoot: 'C:/work/panel',
      cwd: 'C:/work/copies/g1',
      home: 'C:/Users/me',
      realPath: (path: string) => path.replace('SOMEON~1', 'someone'),
    };
    const fires = (event: WatchEvent, over: Partial<WatchContext> = {}) =>
      rules({ events: [event], ctx: { ...ctx, ...over }, now: T0 + MIN }).includes('R7');
    expect(fires(bash(T0, 'cd C:/work/panel && git log -1'))).toBe(true);
    expect(fires(tool(T0, 'Read', { file_path: '../../panel/apps/x.ts' }))).toBe(true);
    expect(
      fires(tool(T0, 'Read', { file_path: '~/panel/a.ts' }), { panelRoot: 'C:/Users/me/panel' }),
    ).toBe(true);
    expect(
      fires(tool(T0, 'Read', { file_path: 'C:/Users/SOMEON~1/panel/a.ts' }), {
        panelRoot: 'C:/Users/someone/panel',
      }),
    ).toBe(true);
    // Свой файл копии относительным путём и соседний каталог с тем же началом имени — не панель.
    expect(fires(tool(T0, 'Read', { file_path: 'src/a.ts' }))).toBe(false);
    expect(fires(tool(T0, 'Read', { file_path: 'C:/work/panel-other/a.ts' }))).toBe(false);
  });

  it('R7 stays quiet on running the panel tests CLI from a copy, fires on reading it', () => {
    const ctx = { panelRoot: 'C:/work/panel', cwd: 'C:/work/copies/g1' };
    const fires = (command: string) =>
      rules({ events: [bash(T0, command)], ctx, now: T0 + MIN }).includes('R7');
    // Так блок «Тесты» велит работать любому проекту — это работа звена.
    expect(fires('node "C:\\work\\panel\\tools\\tests-cli.mjs" list --project .')).toBe(false);
    expect(fires('T="C:/work/panel/tools/tests-cli.mjs"; node "$T" run --case a:b')).toBe(false);
    // Чтение того же файла и запуск любого другого скрипта панели — R7.
    expect(fires('sed -n 1,40p C:/work/panel/tools/tests-cli.mjs')).toBe(true);
    expect(fires('node C:/work/panel/tools/doctor.mjs')).toBe(true);
    expect(fires('node C:/work/panel/tools/tests-cli.mjs; cat C:/work/panel/apps/x.ts')).toBe(true);
  });

  it('subagent push and panel read count for the link: R6 with its stage, R7', () => {
    const side = (event: WatchEvent): WatchEvent => ({ ...event, sidechain: true }) as WatchEvent;
    const push = [side(bash(T0, 'git push origin HEAD', 'p1', 'work')), done(T0 + 1000, 'p1')];
    expect(
      hits({ events: push, node: { deliverAhead: true }, now: T0 + MIN }).find(
        (h) => h.rule === 'R6',
      )?.params,
    ).toEqual({ op: 'push', stage: 'work' });
    const read = [side(tool(T0, 'Read', { file_path: '/work/panel/apps/x.ts' }))];
    const ctx = { panelRoot: '/work/panel', cwd: '/work/panel/.worktrees/g1' };
    expect(rules({ events: read, ctx, now: T0 + MIN })).toContain('R7');
  });

  it('subagent calls never evict the session ring; limit samples are not session state', () => {
    const context: WatchContext = { settings: GROUP_WATCH_DEFAULTS };
    const state = createWatchState(T0);
    reduce(state, call(T0), context);
    for (let n = 1; n <= 250; n++) reduce(state, call(T0 + n, { sidechain: true }), context);
    expect(state.calls).toHaveLength(1);
    reduce(state, { kind: 'limit', t: T0, utilization: 0.5, resetsAt: 1 }, context);
    expect(state).not.toHaveProperty('limits');
    expect(state.rejectedAt).toBeUndefined();
  });
});
