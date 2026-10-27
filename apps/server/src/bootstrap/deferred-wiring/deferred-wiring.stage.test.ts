import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AppStore } from '../../lib/app-store/app-store.ts';
import type {
  ChatLink,
  SplitPlanGroupRecord,
  SplitPlanRecord,
} from '../../lib/app-store/app-store.types.ts';
import type { ServerContext } from '../../context.ts';
import type { RunSnapshot } from '../../domains/chat/ChatRunRegistry/ChatRunRegistry.ts';
import type { RunOptions } from '../../domains/chat/ChatRunner/ChatRunner.ts';
import {
  decideDeferred,
  deferredAsksOf,
} from '../../routes/chat/deferred-routes/deferred-store.ts';
import { wireDeferredAsks } from './deferred-wiring.ts';
import { staleFolderOfAsk } from './rejudge.ts';

/**
 * Слово об исходе D-n и стадия группы (split d9869abf, F1 и F7). Настоящая запись
 * на диске и настоящий `decideDeferred`; подменены очередь слов группы и реестр.
 *
 * F1: оркестратору ревью (MR у звена доставки впереди) слово велело «снять черновик
 * и довести доставку»; слово, ждавшее агентов, будило закончившееся звено.
 * F7: D-n, спрошенный ревью, ждал человека до вечера после конца ревью и держал MR
 * черновиком; разрешённый — уходил в `cd` в уже убранную папку.
 */

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const SCOPE = { kind: 'group' as const, parentChatId: 'parent', groupIndex: 0 };

function link(stage: string): ChatLink {
  return {
    parentChatId: 'parent',
    groupIndex: 0,
    branch: 'feature/g',
    stage,
    createdAt: '2026-10-26T00:00:00.000Z',
  };
}

interface Stand {
  root: string;
  ctx: ServerContext;
  /** Что дошло до группы: `<chatId группы>:<текст>`. */
  delivered: string[];
  /** Слова в очереди — доставить позже. */
  queued: Array<() => void>;
  mode: { outcome: 'sent' | 'queued' };
  timers: Array<() => void>;
  intervals: Array<() => void>;
  agents: Map<string, number>;
  started: Array<{ key: string; options: RunOptions }>;
  wiring: ReturnType<typeof wireDeferredAsks>;
}

function stand(group: Partial<SplitPlanGroupRecord> = {}): Stand {
  const root = mkdtempSync(join(tmpdir(), 'cc-deferred-stage-'));
  dirs.push(root);
  const appData = join(root, 'agentdeck');
  mkdirSync(appData, { recursive: true });
  const store = new AppStore(appData);
  store.setSplitPlan({
    parentChatId: 'parent',
    projectPath: join(root, 'repo'),
    createdAt: '2026-10-26T00:00:00.000Z',
    groups: [
      {
        index: 0,
        title: 'g',
        status: 'background',
        chatId: 'review-chat',
        deliver: true,
        ...group,
      },
    ],
  } as unknown as SplitPlanRecord);
  store.setChatLink('review-chat', link('review'));
  const ctx = { store, location: { paths: { root, appData } } } as unknown as ServerContext;
  const delivered: string[] = [];
  const queued: Array<() => void> = [];
  const mode: Stand['mode'] = { outcome: 'sent' };
  const timers: Array<() => void> = [];
  const intervals: Array<() => void> = [];
  const agents = new Map<string, number>();
  const started: Stand['started'] = [];
  const snapshot: RunSnapshot = {
    key: 'chat-1',
    status: 'done',
    options: { prompt: 'old', cwd: root } as RunOptions,
    meta: { projectPath: root },
    sessionId: 'sess-1',
  };
  const wiring = wireDeferredAsks({
    ctx,
    runs: {
      isRunning: () => false,
      describe: () => undefined,
      describeIdle: (key) => (key === 'chat-1' ? snapshot : undefined),
      start: (key, options) => {
        started.push({ key, options });
        return true;
      },
      liveAgentsOf: (key) => agents.get(key) ?? 0,
    },
    resumeGroup: (target, prompt, onSent, render) => {
      const deliver = (): void => {
        const text = render ? render() : prompt;
        if (text === undefined) return;
        delivered.push(`${target.chatId}:${text}`);
        onSent?.();
      };
      if (mode.outcome === 'queued') queued.push(deliver);
      else deliver();
      return mode.outcome;
    },
    staleFolder: (record) =>
      staleFolderOfAsk(record, { source: store, projectsDir: join(root, 'projects') }),
    setTimer: (run) => timers.push(run),
    setInterval: (run) => intervals.push(run),
  });
  return { root, ctx, delivered, queued, mode, timers, intervals, agents, started, wiring };
}

function ask(ctx: ServerContext, runKeys: string[], extra: { cwd?: string } = {}) {
  return deferredAsksOf(ctx).ask({
    scope: SCOPE,
    runKeys,
    toolName: 'Bash',
    input: { command: 'pnpm content:check' },
    reason: 'test',
    ...extra,
  }).record;
}

function moveGroupTo(s: Stand, chatId: string, stage: string): void {
  s.ctx.store.setChatLink(chatId, link(stage));
  const plan = s.ctx.store.getSplitPlan('parent') as SplitPlanRecord;
  s.ctx.store.setSplitPlan({
    ...plan,
    groups: plan.groups.map((g) => ({ ...g, chatId, status: 'started' })),
  } as SplitPlanRecord);
}

const flush = (): Promise<void> => new Promise((done) => setTimeout(done, 0));

async function everyMinute(s: Stand): Promise<void> {
  for (const run of s.intervals) run();
  await flush();
  await flush();
}

describe('deferred-wiring › слово о MR — только группе, чей MR (F1)', () => {
  it('ревью с доставкой впереди: отказ без «снимите черновик», с «доделайте стадию»', async () => {
    const s = stand();
    const record = ask(s.ctx, ['review-chat']);
    await decideDeferred(s.ctx, record.id, { behavior: 'deny', message: 'нет', via: 'auto' });
    expect(s.delivered).toHaveLength(1);
    expect(s.delivered[0]).not.toContain('MR');
    expect(s.delivered[0]).toContain('finish the remaining work of this stage');
  });

  it('человек отказал ревью: пробел назвать в отчёте, не в описании MR', async () => {
    const s = stand();
    const record = ask(s.ctx, ['review-chat']);
    await decideDeferred(s.ctx, record.id, { behavior: 'deny', via: 'web' });
    expect(s.delivered[0]).toContain('name it as a gap in your report');
    expect(s.delivered[0]).not.toContain('MR description');
  });

  it('звено доставки: слово по-прежнему велит снять черновик', async () => {
    const s = stand();
    s.ctx.store.setChatLink('review-chat', link('deliver'));
    const record = ask(s.ctx, ['review-chat']);
    await decideDeferred(s.ctx, record.id, { behavior: 'deny', via: 'auto' });
    expect(s.delivered[0]).toContain('take the MR out of draft and finish the delivery');
  });

  it('группа без звена доставки (MR ведёт сама цепочка): слово о черновике остаётся', async () => {
    const s = stand({ deliver: false });
    const record = ask(s.ctx, ['review-chat']);
    await decideDeferred(s.ctx, record.id, { behavior: 'allow', via: 'web' });
    expect(s.delivered[0]).toContain('take the MR out of draft');
  });
});

describe('deferred-wiring › слово, ждавшее в очереди, не будит закончившееся звено (F1)', () => {
  it('группа ушла в правки, пока слово ждало, — слово говорится текущему разговору', async () => {
    const s = stand();
    s.mode.outcome = 'queued';
    const record = ask(s.ctx, ['review-chat']);
    await decideDeferred(s.ctx, record.id, { behavior: 'deny', via: 'auto' });
    moveGroupTo(s, 'fix-chat', 'fix');
    s.mode.outcome = 'sent';

    s.queued.shift()?.();
    expect(s.delivered).toEqual([]);
    for (const run of s.timers.splice(0)) run();

    expect(s.delivered).toHaveLength(1);
    expect(s.delivered[0]).toMatch(/^fix-chat:/);
    expect(deferredAsksOf(s.ctx).get(record.id)?.toldAt).toBeDefined();
  });
});

describe('deferred-wiring › одиночный чат с фоновыми агентами ждёт их конца (F1)', () => {
  it('ход кончился, агент идёт — продолжение ждёт; конец хода без агентов — продолжает', async () => {
    const s = stand();
    s.agents.set('chat-1', 2);
    const record = deferredAsksOf(s.ctx).ask({
      scope: { kind: 'chat', chatKeys: ['chat-1', 'sess-1'] },
      runKeys: ['chat-1', 'sess-1'],
      toolName: 'Bash',
      input: { command: 'pnpm build' },
      reason: 'test',
    }).record;
    const result = await decideDeferred(s.ctx, record.id, { behavior: 'allow', via: 'web' });
    expect(result?.resume).toBe('parked');
    expect(s.started).toEqual([]);

    s.agents.set('chat-1', 0);
    s.wiring.finished(['chat-1']);
    for (const run of s.timers.splice(0)) run();
    expect(s.started).toHaveLength(1);
    expect(s.started[0]?.options.prompt).toContain(`allowed ${record.id}`);
  });
});

describe('deferred-wiring › ждущая запись закончившейся стадии закрывается сама (F7)', () => {
  it('ревью кончилось, группа в правках: D-n ревью отказан панелью с причиной, слово — правкам', async () => {
    const s = stand();
    const record = ask(s.ctx, ['review-chat']);
    moveGroupTo(s, 'fix-chat', 'fix');

    await everyMinute(s);

    const closed = deferredAsksOf(s.ctx).get(record.id);
    expect(closed?.state).toBe('denied');
    expect(closed?.decidedVia).toBe('auto');
    expect(closed?.message).toContain('the review stage that asked for it has ended');
    expect(s.delivered).toHaveLength(1);
    expect(s.delivered[0]).toMatch(/^fix-chat:/);
  });

  it('та же стадия — запись ждёт человека', async () => {
    const s = stand();
    const record = ask(s.ctx, ['review-chat']);
    await everyMinute(s);
    expect(deferredAsksOf(s.ctx).get(record.id)?.state).toBe('waiting');
  });

  it('каталог, где спросили, убран — отказ панели: исполнять негде', async () => {
    const s = stand();
    const gone = join(s.root, 'review-clone');
    mkdirSync(gone);
    const record = ask(s.ctx, ['review-chat'], { cwd: gone });
    rmSync(gone, { recursive: true });

    await everyMinute(s);

    const closed = deferredAsksOf(s.ctx).get(record.id);
    expect(closed?.state).toBe('denied');
    expect(closed?.message).toContain(`the folder ${gone} this call was asked in no longer exists`);
  });

  it('при старте панели — тот же суд (reDrive)', async () => {
    const s = stand();
    const record = ask(s.ctx, ['review-chat']);
    moveGroupTo(s, 'fix-chat', 'fix');
    await s.wiring.reDrive();
    expect(deferredAsksOf(s.ctx).get(record.id)?.state).toBe('denied');
  });
});
