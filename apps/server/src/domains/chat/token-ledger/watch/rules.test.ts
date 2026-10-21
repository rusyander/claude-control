import { describe, expect, it } from 'vitest';
import { GROUP_WATCH_DEFAULTS, type GroupWatch } from '@agentdeck/contracts/group-watch';
import { createWatchState, isSleepPoll, normPath, reduce } from './reduce.ts';
import { EVENT_HOLD_MS, evaluate } from './rules.ts';
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
  model: 'claude-opus-4',
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
    const r6 = (command: string, stage = 'work', node: Partial<WatchNode> = ahead) =>
      rules({ events: [bash(T0, command, 'p', stage)], node, now: T0 + MIN }).includes('R6');
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
        events: [bash(T0, 'git push', 'p', 'work')],
        node: ahead,
        now: T0 + EVENT_HOLD_MS + 2 * MIN,
      }),
    ).not.toContain('R6');
    // MR через MCP — тоже публикация.
    expect(
      rules({
        events: [tool(T0, 'mcp__forge__create_merge_request', {}, 'work')],
        node: ahead,
        now: T0 + MIN,
      }),
    ).toContain('R6');
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

  it('R8 fires on a burn rate above the threshold over a stream of calls', () => {
    // Opus, 1M часовой записи: 5 × 2 = 10 W за вызов.
    const heavy = [1, 2, 3].map((n) =>
      call(T0 + n * MIN, {
        cacheRead: 0,
        cacheWrite: 1_000_000,
        cacheWrite1h: 1_000_000,
        output: 0,
        input: 0,
      }),
    );
    expect(
      hits({ events: heavy, now: T0 + 5 * MIN }).find((h) => h.rule === 'R8')?.numbers,
    ).toEqual({
      perHour: 120,
    });
    expect(rules({ events: heavy.slice(0, 2), now: T0 + 5 * MIN })).not.toContain('R8');
    expect(
      rules({ events: heavy, settings: { burnPerHour: 150 }, now: T0 + 5 * MIN }),
    ).not.toContain('R8');
  });

  it('R9 projects the five-hour window to its reset', () => {
    const resetsAt = (T0 + 60 * MIN) / 1000;
    const rising = [
      { kind: 'limit', t: T0, utilization: 0.5, resetsAt } as WatchEvent,
      { kind: 'limit', t: T0 + 10 * MIN, utilization: 0.6, resetsAt } as WatchEvent,
    ];
    expect(
      hits({ events: rising, now: T0 + 10 * MIN }).find((h) => h.rule === 'R9')?.numbers,
    ).toEqual({
      projectedPct: 110,
      nowPct: 60,
      resetMin: 50,
    });
    const flat = [
      { kind: 'limit', t: T0, utilization: 0.5, resetsAt } as WatchEvent,
      { kind: 'limit', t: T0 + 10 * MIN, utilization: 0.52, resetsAt } as WatchEvent,
    ];
    expect(rules({ events: flat, now: T0 + 10 * MIN })).not.toContain('R9');
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

  it('normPath folds Git Bash, case and slashes', () => {
    expect(normPath('/c/Work/App/')).toBe('c:/work/app');
    expect(normPath('C:\\Work\\App')).toBe('c:/work/app');
  });
});
