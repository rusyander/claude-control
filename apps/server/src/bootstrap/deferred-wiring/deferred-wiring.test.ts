import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AppStore } from '../../lib/app-store/app-store.ts';
import type { SplitPlanGroupRecord, SplitPlanRecord } from '../../lib/app-store/app-store.types.ts';
import type { ServerContext } from '../../context.ts';
import type { RunSnapshot } from '../../domains/chat/ChatRunRegistry/ChatRunRegistry.ts';
import type { RunOptions } from '../../domains/chat/ChatRunner/ChatRunner.ts';
import type { RunMeta } from '../../domains/chat/ChatRunRegistry/ChatRunRegistry.types.ts';
import {
  decideDeferred,
  deferredAsksOf,
} from '../../routes/chat/deferred-routes/deferred-store.ts';
import { wireDeferredAsks, type DeferredWiringDeps } from './deferred-wiring.ts';

/**
 * Продолжение после решения D-n (решение 7): тот же путь решения, что у
 * маршрута (`decideDeferred`), настоящая запись на диске во временной папке
 * данных. Перезапуск панели — новый контекст сервера над той же папкой:
 * запись читается с диска, как после настоящего перезапуска.
 */

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function context(root: string, groupStatus = 'started'): ServerContext {
  const appData = join(root, 'agentdeck');
  mkdirSync(appData, { recursive: true });
  const store = new AppStore(appData);
  store.setSplitPlan({
    parentChatId: 'parent',
    projectPath: join(root, 'repo'),
    createdAt: '2026-10-23T10:00:00.000Z',
    groups: [{ index: 0, title: 'g', status: groupStatus, chatId: 'group-chat' }],
  } as unknown as SplitPlanRecord);
  return { store, location: { paths: { root, appData } } } as unknown as ServerContext;
}

interface Harness {
  ctx: ServerContext;
  /** Каждый вызов очереди группы — текст в миг постановки. */
  groupPrompts: string[];
  /** Что ДОШЛО до группы: текст складывается в миг доставки (`render`), как в `child-tell.ts`. */
  delivered: string[];
  started: Array<{ key: string; options: RunOptions; meta: RunMeta }>;
  running: Set<string>;
  timers: Array<() => void>;
  /** Доставка слова группе: позвать — значит «слово дошло» (D-L02). */
  deliveries: Array<() => void>;
  /** Слово вынуто из очереди, но старт отказал (RF-DL-13): текст сложен, `onSent` не зван. */
  refusals: Array<() => void>;
  /** Повторный обход по часам (D-L05) — вместо настоящей минуты. */
  intervals: Array<{ run: () => void; ms: number }>;
  /** Что очередь ответит на следующее слово — тест меняет по ходу. */
  mode: { outcome: 'sent' | 'queued' | 'refused' };
  wiring: ReturnType<typeof wireDeferredAsks>;
}

function harness(
  root: string,
  extra: {
    groupStatus?: string;
    known?: boolean;
    /** Что отвечает очередь группы: доставлено сразу или положено в очередь. */
    groupOutcome?: 'sent' | 'queued' | 'refused';
  } = {},
): Harness {
  const ctx = context(root, extra.groupStatus);
  const groupPrompts: string[] = [];
  const started: Harness['started'] = [];
  const running = new Set<string>();
  const timers: Array<() => void> = [];
  const snapshot: RunSnapshot = {
    key: 'chat-1',
    status: 'done',
    options: { prompt: 'старый ход', cwd: root, fork: true, hold: true } as RunOptions,
    meta: { projectPath: root },
    sessionId: 'sess-1',
  };
  const runs: DeferredWiringDeps['runs'] = {
    isRunning: (key) => running.has(key),
    describe: () => undefined,
    describeIdle: (key) => (extra.known !== false && key === 'chat-1' ? snapshot : undefined),
    start: (key, options, meta) => {
      started.push({ key, options, meta });
      return true;
    },
  };
  const deliveries: Array<() => void> = [];
  const refusals: Array<() => void> = [];
  const delivered: string[] = [];
  const intervals: Harness['intervals'] = [];
  const mode: Harness['mode'] = { outcome: extra.groupOutcome ?? 'sent' };
  const wiring = wireDeferredAsks({
    ctx,
    runs,
    resumeGroup: (group: SplitPlanGroupRecord, prompt, onSent, render) => {
      groupPrompts.push(`${group.index}:${prompt}`);
      // Как `ChildTells.deliver`: текст — в миг доставки; `undefined` — слово не уходит.
      const deliver = (): void => {
        const text = render ? render() : prompt;
        if (text === undefined) return;
        delivered.push(`${group.index}:${text}`);
        onSent?.();
      };
      const outcome = mode.outcome;
      // «sent» — слово ушло сразу: очередь зовёт `onSent` в тот же миг.
      if (outcome === 'sent') deliver();
      if (outcome === 'queued') {
        deliveries.push(deliver);
        refusals.push(() => void render?.());
      }
      return outcome;
    },
    setTimer: (run) => timers.push(run),
    setInterval: (run, ms) => intervals.push({ run, ms }),
  });
  return {
    ctx,
    groupPrompts,
    delivered,
    started,
    running,
    timers,
    deliveries,
    refusals,
    intervals,
    mode,
    wiring,
  };
}

/**
 * Перезапуск панели: новый процесс стартует позже, чем прежний сказал слово
 * (`toldAt` < старта, RF-DL-06). Часы те же, что у записи, — настоящие.
 */
const restart = (): Promise<void> => new Promise((done) => setTimeout(done, 5));

const SCOPE = { kind: 'group' as const, parentChatId: 'parent', groupIndex: 0 };

function askGroupCall(ctx: ServerContext, command: string) {
  return deferredAsksOf(ctx).ask({
    scope: SCOPE,
    runKeys: ['group-chat'],
    toolName: 'Bash',
    input: { command },
    reason: 'row database',
  }).record;
}

/** Срок ожидания записи — в прошлое: следующая уборка её закроет. */
function lapseWait(ctx: ServerContext, id: string): void {
  (deferredAsksOf(ctx).get(id) as { expiresAt: string }).expiresAt = new Date(
    Date.now() - 1_000,
  ).toISOString();
}

function unpause(ctx: ServerContext): void {
  const plan = ctx.store.getSplitPlan('parent') as SplitPlanRecord;
  ctx.store.setSplitPlan({
    ...plan,
    groups: plan.groups.map((group) => ({ ...group, status: 'started' })),
  } as SplitPlanRecord);
}

const tempRoot = (): string => {
  const root = mkdtempSync(join(tmpdir(), 'cc-deferred-wiring-'));
  dirs.push(root);
  return root;
};

const DROP = { command: 'psql -c "DROP TABLE users"' };

/** Обход внутри тика асинхронный — даём ему дойти до конца. */
const tick = (): Promise<void> => new Promise((done) => setTimeout(done, 0));

function askGroup(ctx: ServerContext) {
  return deferredAsksOf(ctx).ask({
    scope: { kind: 'group', parentChatId: 'parent', groupIndex: 0 },
    runKeys: ['group-chat'],
    toolName: 'Bash',
    input: DROP,
    reason: 'row database',
  }).record;
}

function askChat(ctx: ServerContext) {
  return deferredAsksOf(ctx).ask({
    scope: { kind: 'chat', chatKeys: ['chat-1', 'sess-1'] },
    runKeys: ['chat-1', 'sess-1'],
    toolName: 'Bash',
    input: DROP,
    reason: 'row database',
  }).record;
}

describe('deferred-wiring › продолжение после решения', () => {
  it('группа: «разрешить» продолжает её точным вызовом, запись помечена — обход не повторит', async () => {
    const h = harness(tempRoot());
    const record = askGroup(h.ctx);
    const result = await decideDeferred(h.ctx, record.id, { behavior: 'allow', via: 'web' });
    expect(result?.resume).toBe('sent');
    expect(h.groupPrompts).toHaveLength(1);
    expect(h.groupPrompts[0]).toContain(`allowed ${record.id}`);
    expect(h.groupPrompts[0]).toContain('psql -c "DROP TABLE users"');
    await h.wiring.reDrive();
    expect(h.groupPrompts).toHaveLength(1);
  });

  it('группа: «запретить» продолжает её словом отказа, без вызова', async () => {
    const h = harness(tempRoot());
    const record = askGroup(h.ctx);
    await decideDeferred(h.ctx, record.id, { behavior: 'deny', message: 'не трогать', via: 'web' });
    expect(h.groupPrompts[0]).toContain(`refused ${record.id}: не трогать`);
    expect(h.groupPrompts[0]).not.toContain('DROP TABLE');
  });

  it('группа на паузе человека — не будится; запись не помечена, обход после паузы продолжит', async () => {
    const root = tempRoot();
    const paused = harness(root, { groupStatus: 'paused' });
    const record = askGroup(paused.ctx);
    const result = await decideDeferred(paused.ctx, record.id, { behavior: 'allow', via: 'web' });
    expect(result?.resume).toBe('none');
    expect(paused.groupPrompts).toEqual([]);
    expect(deferredAsksOf(paused.ctx).get(record.id)?.resumedAt).toBeUndefined();
  });

  it('одиночный чат с идущим ходом — продолжение ждёт конца хода и идёт тем же разговором', async () => {
    const h = harness(tempRoot());
    const record = askChat(h.ctx);
    h.running.add('chat-1');
    const result = await decideDeferred(h.ctx, record.id, { behavior: 'allow', via: 'mobile' });
    expect(result?.resume).toBe('parked');
    expect(h.started).toEqual([]);
    // «parked» не помечается: перезапуск до конца хода продолжит обходом.
    expect(deferredAsksOf(h.ctx).get(record.id)?.resumedAt).toBeUndefined();
    h.running.delete('chat-1');
    h.wiring.finished(['other-chat']);
    expect(h.timers).toHaveLength(0);
    h.wiring.finished(['chat-1']);
    expect(h.timers).toHaveLength(1);
    h.timers[0]!();
    expect(h.started).toHaveLength(1);
    expect(h.started[0]).toMatchObject({ key: 'chat-1', options: { sessionId: 'sess-1' } });
    expect(h.started[0]?.options.prompt).toContain(`allowed ${record.id}`);
    expect(h.started[0]?.options.fork).toBeUndefined();
    expect(h.started[0]?.options.hold).toBeUndefined();
    expect(deferredAsksOf(h.ctx).get(record.id)?.resumedAt).toBeTruthy();
    // Второй конец хода ничего не повторяет.
    h.wiring.finished(['chat-1']);
    expect(h.timers).toHaveLength(1);
  });

  it('перезапуск между решением и продолжением: обход при старте продолжает один раз', async () => {
    const root = tempRoot();
    const before = harness(root, { groupStatus: 'paused' });
    const record = askGroup(before.ctx);
    await decideDeferred(before.ctx, record.id, { behavior: 'allow', via: 'web' });
    // Новый процесс панели: новый контекст, запись — с диска; группу сняли с паузы.
    const after = harness(root);
    expect(deferredAsksOf(after.ctx)).not.toBe(deferredAsksOf(before.ctx));
    expect(deferredAsksOf(after.ctx).get(record.id)?.state).toBe('allowed');
    await after.wiring.reDrive();
    await after.wiring.reDrive();
    expect(after.groupPrompts).toHaveLength(1);
    expect(after.groupPrompts[0]).toContain(`allowed ${record.id}`);
  });

  it('перезапуск: одиночный чат, которого реестр не знает, сам не продолжается — разрешение ждёт свой срок', async () => {
    const root = tempRoot();
    const before = harness(root);
    const record = askChat(before.ctx);
    before.running.add('chat-1');
    await decideDeferred(before.ctx, record.id, { behavior: 'allow', via: 'web' });
    const after = harness(root, { known: false });
    await after.wiring.reDrive();
    expect(after.started).toEqual([]);
    const kept = deferredAsksOf(after.ctx).get(record.id);
    expect(kept?.state).toBe('allowed');
    expect(kept?.resumedAt).toBeUndefined();
    // Разрешение использует следующий ход: точный вызов проходит один раз.
    const scope = { kind: 'chat' as const, chatKeys: ['chat-1'] };
    expect(deferredAsksOf(after.ctx).consume(scope, 'Bash', DROP)?.id).toBe(record.id);
    expect(deferredAsksOf(after.ctx).consume(scope, 'Bash', DROP)).toBeUndefined();
  });
});

describe('deferred-wiring › слово в очереди ещё не доставка (D-L02)', () => {
  it('«в очереди» запись не помечает; помечает доставка, и обход её не повторяет', async () => {
    const h = harness(tempRoot(), { groupOutcome: 'queued' });
    const record = askGroup(h.ctx);
    const result = await decideDeferred(h.ctx, record.id, { behavior: 'allow', via: 'web' });
    expect(result?.resume).toBe('queued');
    expect(deferredAsksOf(h.ctx).get(record.id)?.resumedAt).toBeUndefined();
    // Пока слово в очереди, обход второго продолжения не шлёт.
    h.intervals[0]?.run();
    await tick();
    expect(h.groupPrompts).toHaveLength(1);
    // Очередь доставила — только теперь запись помечена.
    h.deliveries[0]?.();
    expect(deferredAsksOf(h.ctx).get(record.id)?.resumedAt).toBeTruthy();
  });

  it('перезапуск до доставки: обход при старте шлёт слово заново (живой прогон R3)', async () => {
    const root = tempRoot();
    const before = harness(root, { groupOutcome: 'queued' });
    const record = askGroup(before.ctx);
    await decideDeferred(before.ctx, record.id, { behavior: 'allow', via: 'web' });
    expect(deferredAsksOf(before.ctx).get(record.id)?.resumedAt).toBeUndefined();

    const after = harness(root, { groupOutcome: 'queued' });
    await after.wiring.reDrive();
    expect(after.groupPrompts).toHaveLength(1);
    expect(after.groupPrompts[0]).toContain(`allowed ${record.id}`);
    // Обход тоже не помечает «в очереди»: следующий перезапуск повторит.
    expect(deferredAsksOf(after.ctx).get(record.id)?.resumedAt).toBeUndefined();
  });
});

describe('deferred-wiring › повторный обход по часам (D-L05)', () => {
  it('группа была на паузе — продолжение уходит на следующем обходе, без перезапуска', async () => {
    const root = tempRoot();
    const paused = harness(root, { groupStatus: 'paused' });
    const record = askGroup(paused.ctx);
    await decideDeferred(paused.ctx, record.id, { behavior: 'allow', via: 'web' });
    expect(paused.groupPrompts).toEqual([]);
    expect(paused.intervals[0]?.ms).toBe(60_000);

    // Человек снял группу с паузы — тот же процесс панели, тот же обход.
    const plan = paused.ctx.store.getSplitPlan('parent') as SplitPlanRecord;
    paused.ctx.store.setSplitPlan({
      ...plan,
      groups: plan.groups.map((group) => ({ ...group, status: 'started' })),
    } as SplitPlanRecord);
    paused.intervals[0]?.run();
    await tick();
    expect(paused.groupPrompts).toHaveLength(1);
    expect(paused.groupPrompts[0]).toContain(`allowed ${record.id}`);
    expect(deferredAsksOf(paused.ctx).get(record.id)?.resumedAt).toBeTruthy();
    // Второй обход ничего не повторяет.
    paused.intervals[0]?.run();
    await tick();
    expect(paused.groupPrompts).toHaveLength(1);
  });
});

describe('deferred-wiring › срок записи как исход (D-L12)', () => {
  it('последняя ждущая запись истекла — группе уходит слово, и оно велит снять черновик', async () => {
    const h = harness(tempRoot());
    const asks = deferredAsksOf(h.ctx);
    const record = asks.ask({
      scope: { kind: 'group', parentChatId: 'parent', groupIndex: 0 },
      runKeys: ['group-chat'],
      toolName: 'Bash',
      input: DROP,
      reason: 'row database',
    }).record;
    // Срок записи — по часам сервера: двигаем сами время записи в прошлое.
    const past = new Date(Date.now() - 1_000).toISOString();
    (asks.get(record.id) as { expiresAt: string }).expiresAt = past;
    asks.sweep();
    expect(asks.get(record.id)?.state).toBe('expired');
    // Слово — после конца уборки (RF-DL-03): микрозадача.
    await tick();
    expect(h.groupPrompts).toHaveLength(1);
    expect(h.groupPrompts[0]).toContain(`${record.id} expired without an answer`);
    expect(h.groupPrompts[0]).toContain('take the MR out of draft');
  });

  it('разрешение истекло неиспользованным — слово своё: человек ответил, слово не дошло', async () => {
    const h = harness(tempRoot());
    const asks = deferredAsksOf(h.ctx);
    const record = askGroup(h.ctx);
    // Человек разрешил, но группа слова не получила (панель стояла): срок вышел.
    const lapsed = asks.get(record.id) as {
      state: string;
      grantUntil: string;
      resumedAt?: string;
    };
    lapsed.state = 'allowed';
    lapsed.grantUntil = new Date(Date.now() - 1_000).toISOString();
    delete lapsed.resumedAt;
    h.groupPrompts.length = 0;
    asks.sweep();
    expect(asks.get(record.id)?.state).toBe('expired');
    await tick();
    expect(h.groupPrompts).toHaveLength(1);
    expect(h.groupPrompts[0]).toContain(`grant for ${record.id} lapsed`);
    expect(h.groupPrompts[0]).not.toContain('without an answer from the human');
    expect(h.groupPrompts[0]).toContain('take the MR out of draft');
  });

  it('разрешение сказано, вызова не было, срок вышел — «разрешение истекло», не «без ответа» (RF-DL-06, живой A9)', async () => {
    const h = harness(tempRoot());
    const asks = deferredAsksOf(h.ctx);
    const record = askGroup(h.ctx);
    await decideDeferred(h.ctx, record.id, { behavior: 'allow', via: 'web' });
    expect(asks.get(record.id)?.resumedAt).toBeTruthy();
    (asks.get(record.id) as { grantUntil: string }).grantUntil = new Date(
      Date.now() - 1_000,
    ).toISOString();
    asks.sweep();
    await tick();
    expect(h.delivered).toHaveLength(2);
    expect(h.delivered[1]).toContain(`grant for ${record.id} lapsed`);
    expect(h.delivered[1]).not.toContain('without an answer from the human');
  });

  it('пока другая запись группы ждёт — слова нет: группа и так стоит на ней', async () => {
    const h = harness(tempRoot());
    const asks = deferredAsksOf(h.ctx);
    const scope = { kind: 'group' as const, parentChatId: 'parent', groupIndex: 0 };
    const first = asks.ask({
      scope,
      runKeys: ['group-chat'],
      toolName: 'Bash',
      input: DROP,
      reason: 'row database',
    }).record;
    asks.ask({
      scope,
      runKeys: ['group-chat'],
      toolName: 'Bash',
      input: { command: 'npm publish' },
      reason: 'publish',
    });
    (asks.get(first.id) as { expiresAt: string }).expiresAt = new Date(
      Date.now() - 1_000,
    ).toISOString();
    asks.sweep();
    expect(asks.get(first.id)?.state).toBe('expired');
    await tick();
    expect(h.groupPrompts).toEqual([]);
  });

  it('три записи истекли одной уборкой — ОДНО слово со всеми номерами (RF-DL-03, живой A1)', async () => {
    const h = harness(tempRoot());
    const asks = deferredAsksOf(h.ctx);
    const ids = ['a', 'b', 'c'].map((name) => askGroupCall(h.ctx, `drop ${name}`).id);
    for (const id of ids) lapseWait(h.ctx, id);
    asks.sweep();
    await tick();
    expect(h.groupPrompts).toHaveLength(1);
    for (const id of ids) expect(h.delivered[0]).toContain(`- ${id}: expired`);
    expect(h.delivered[0]).toContain('Nothing of this work waits for the human any more');
    // Обход после доставки ничего не повторяет: исходы помечены «сказано».
    h.intervals[0]?.run();
    await tick();
    expect(h.groupPrompts).toHaveLength(1);
  });

  it('разрешение, пришедшее сразу после срока ожидания, — одно слово «разрешено», без «истекло» (RF-DL-15, живой A6)', async () => {
    const h = harness(tempRoot());
    const record = askGroup(h.ctx);
    lapseWait(h.ctx, record.id);
    await decideDeferred(h.ctx, record.id, { behavior: 'allow', via: 'web' });
    await tick();
    expect(h.delivered).toHaveLength(1);
    expect(h.delivered[0]).toContain(`allowed ${record.id}`);
    expect(h.delivered.join('\n')).not.toContain('expired');
  });

  it('ответ сразу после срока, соседняя запись истекла той же уборкой — одно слово: этот разрешён, соседний истёк (RF-DL-15)', async () => {
    const h = harness(tempRoot());
    const decided = askGroupCall(h.ctx, 'publish');
    const sibling = askGroupCall(h.ctx, 'drop');
    lapseWait(h.ctx, decided.id);
    lapseWait(h.ctx, sibling.id);
    await decideDeferred(h.ctx, decided.id, { behavior: 'allow', via: 'web' });
    await tick();
    const said = h.delivered.join('\n');
    expect(said).toContain(`- ${decided.id}: the human allowed it`);
    expect(said).toContain(`- ${sibling.id}: expired`);
    expect(said).not.toContain(`- ${decided.id}: expired`);
    expect(h.delivered).toHaveLength(1);
  });

  it('одиночный чат: истечение ожидания разговор не продолжает', async () => {
    const h = harness(tempRoot());
    const record = askChat(h.ctx);
    lapseWait(h.ctx, record.id);
    deferredAsksOf(h.ctx).sweep();
    await tick();
    await h.wiring.reDrive();
    expect(h.started).toEqual([]);
  });
});

describe('deferred-wiring › исход переживает очередь, паузу и перезапуск', () => {
  it('истечение при идущем ходе + перезапуск до конца хода — слово доходит в новом процессе (RF-DL-04, живой A2)', async () => {
    const root = tempRoot();
    const before = harness(root, { groupOutcome: 'queued' });
    const record = askGroup(before.ctx);
    lapseWait(before.ctx, record.id);
    deferredAsksOf(before.ctx).sweep();
    await tick();
    expect(before.groupPrompts).toHaveLength(1);
    expect(before.delivered).toEqual([]);
    // Процесс умер с словом в очереди. Новый процесс — с диска.
    await restart();
    const after = harness(root);
    await after.wiring.reDrive();
    expect(after.delivered).toHaveLength(1);
    expect(after.delivered[0]).toContain(`${record.id} expired without an answer`);
    await after.wiring.reDrive();
    expect(after.delivered).toHaveLength(1);
  });

  it('разрешено на паузе, срок разрешения вышел до снятия паузы — после паузы группа узнаёт (RF-DL-05, живой A5)', async () => {
    const h = harness(tempRoot(), { groupStatus: 'paused' });
    const record = askGroup(h.ctx);
    await decideDeferred(h.ctx, record.id, { behavior: 'allow', via: 'web' });
    (deferredAsksOf(h.ctx).get(record.id) as { grantUntil: string }).grantUntil = new Date(
      Date.now() - 1_000,
    ).toISOString();
    deferredAsksOf(h.ctx).sweep();
    await tick();
    expect(deferredAsksOf(h.ctx).get(record.id)?.state).toBe('expired');
    expect(h.groupPrompts).toEqual([]);
    unpause(h.ctx);
    h.intervals[0]?.run();
    await tick();
    expect(h.delivered).toHaveLength(1);
    expect(h.delivered[0]).toContain(`grant for ${record.id} lapsed`);
  });

  it('отказ на паузе + перезапуск — новый процесс говорит отказ один раз', async () => {
    const root = tempRoot();
    const before = harness(root, { groupStatus: 'paused' });
    const record = askGroup(before.ctx);
    await decideDeferred(before.ctx, record.id, { behavior: 'deny', message: 'нет', via: 'web' });
    expect(before.groupPrompts).toEqual([]);
    await restart();
    const after = harness(root);
    await after.wiring.reDrive();
    await after.wiring.reDrive();
    expect(after.delivered).toHaveLength(1);
    expect(after.delivered[0]).toContain(`refused ${record.id}: нет`);
  });

  it('разрешение сказано, вызова не было, панель перезапущена — новый процесс говорит его снова, один раз (RF-DL-06)', async () => {
    const root = tempRoot();
    const before = harness(root);
    const record = askGroup(before.ctx);
    await decideDeferred(before.ctx, record.id, { behavior: 'allow', via: 'web' });
    expect(before.delivered).toHaveLength(1);
    await before.wiring.reDrive();
    expect(before.delivered).toHaveLength(1);
    await restart();
    const after = harness(root);
    await after.wiring.reDrive();
    await after.wiring.reDrive();
    expect(after.delivered).toHaveLength(1);
    expect(after.delivered[0]).toContain(`allowed ${record.id}`);
    // Вызов сделан — третьему процессу говорить нечего.
    expect(deferredAsksOf(after.ctx).consume(SCOPE, 'Bash', DROP)?.id).toBe(record.id);
    await restart();
    const third = harness(root);
    await third.wiring.reDrive();
    expect(third.groupPrompts).toEqual([]);
  });
});

describe('deferred-wiring › одно слово в очереди за все исходы', () => {
  it('обход при старте не ставит второе слово, пока первое в очереди (RF-DL-01, живой A10)', async () => {
    const h = harness(tempRoot(), { groupOutcome: 'queued' });
    const record = askGroup(h.ctx);
    await decideDeferred(h.ctx, record.id, { behavior: 'allow', via: 'web' });
    await h.wiring.reDrive();
    h.intervals[0]?.run();
    await tick();
    expect(h.groupPrompts).toHaveLength(1);
    h.deliveries[0]?.();
    expect(h.delivered).toHaveLength(1);
    expect(deferredAsksOf(h.ctx).get(record.id)?.toldAt).toBeTruthy();
  });

  it('слово складывается в миг доставки: использованное разрешение не повторяется (RF-DL-01)', async () => {
    const h = harness(tempRoot(), { groupOutcome: 'queued' });
    const record = askGroup(h.ctx);
    await decideDeferred(h.ctx, record.id, { behavior: 'allow', via: 'web' });
    // Вызов прошёл раньше, чем очередь дошла до слова.
    expect(deferredAsksOf(h.ctx).consume(SCOPE, 'Bash', DROP)?.id).toBe(record.id);
    h.deliveries[0]?.();
    expect(h.delivered).toEqual([]);
  });

  it('три отказа, пока слово в очереди, — ОДНО слово со всеми тремя (RF-DL-16, живой A7)', async () => {
    const h = harness(tempRoot(), { groupOutcome: 'queued' });
    const ids = ['a', 'b', 'c'].map((name) => askGroupCall(h.ctx, `drop ${name}`).id);
    const resumes: Array<string | undefined> = [];
    for (const id of ids) {
      const result = await decideDeferred(h.ctx, id, { behavior: 'deny', via: 'web' });
      resumes.push(result?.resume);
    }
    expect(resumes).toEqual(['queued', 'queued', 'queued']);
    expect(h.groupPrompts).toHaveLength(1);
    h.deliveries[0]?.();
    expect(h.delivered).toHaveLength(1);
    for (const id of ids) expect(h.delivered[0]).toContain(`- ${id}: the human refused it`);
    for (const id of ids) expect(deferredAsksOf(h.ctx).get(id)?.toldAt).toBeTruthy();
  });

  it('разрешение и истечение одной группы — одно слово про оба (RF-DL-03 + D-L12)', async () => {
    const h = harness(tempRoot(), { groupOutcome: 'queued' });
    const allowed = askGroupCall(h.ctx, 'publish');
    const lapsed = askGroupCall(h.ctx, 'drop');
    await decideDeferred(h.ctx, allowed.id, { behavior: 'allow', via: 'web' });
    lapseWait(h.ctx, lapsed.id);
    deferredAsksOf(h.ctx).sweep();
    await tick();
    expect(h.groupPrompts).toHaveLength(1);
    h.deliveries[0]?.();
    expect(h.delivered).toHaveLength(1);
    expect(h.delivered[0]).toContain(`- ${allowed.id}: the human allowed it`);
    expect(h.delivered[0]).toContain(`- ${lapsed.id}: expired`);
  });

  it('слово вынуто из очереди, но старт отказал — следующий обход говорит снова (RF-DL-13)', async () => {
    const h = harness(tempRoot(), { groupOutcome: 'queued' });
    const record = askGroup(h.ctx);
    await decideDeferred(h.ctx, record.id, { behavior: 'deny', via: 'web' });
    h.refusals[0]?.();
    expect(deferredAsksOf(h.ctx).get(record.id)?.toldAt).toBeUndefined();
    h.mode.outcome = 'sent';
    h.intervals[0]?.run();
    await tick();
    expect(h.groupPrompts).toHaveLength(2);
    expect(h.delivered).toHaveLength(1);
    expect(h.delivered[0]).toContain(`refused ${record.id}`);
  });
});

describe('deferred-wiring › убранной группе и отменённому плану слова нет (RF-DL-10)', () => {
  /** План целиком отменён или группа убрана человеком — как их помечает конвейер. */
  function remove(ctx: ServerContext, how: 'cancel' | 'drop'): void {
    const plan = ctx.store.getSplitPlan('parent') as SplitPlanRecord;
    const at = new Date().toISOString();
    ctx.store.setSplitPlan({
      ...plan,
      ...(how === 'cancel' ? { cancelledAt: at } : {}),
      groups: plan.groups.map((group) => ({
        ...group,
        status: 'failed',
        ...(how === 'drop' ? { droppedAt: at } : {}),
      })),
    } as SplitPlanRecord);
  }

  for (const how of ['cancel', 'drop'] as const) {
    it(`${how}: несказанный отказ и истечение не будят группу — ни решением, ни обходом, ни после перезапуска`, async () => {
      const root = tempRoot();
      const h = harness(root);
      const denied = askGroupCall(h.ctx, 'git push');
      const lapsed = askGroupCall(h.ctx, 'psql -c "DROP TABLE t"');
      remove(h.ctx, how);
      // Отказ, отданный уже после закрытия, и срок, вышедший после него, —
      // оба исхода остаются несказанными, а говорить их некому.
      await decideDeferred(h.ctx, denied.id, { behavior: 'deny', via: 'web' });
      lapseWait(h.ctx, lapsed.id);
      deferredAsksOf(h.ctx).all();
      await tick();
      for (const pass of h.intervals) pass.run();
      expect(h.groupPrompts).toEqual([]);

      await restart();
      const after = harness(root);
      remove(after.ctx, how);
      await after.wiring.reDrive();
      await tick();
      for (const pass of after.intervals) pass.run();
      expect(after.groupPrompts).toEqual([]);
    });
  }
});

describe('deferred-wiring › слово в очереди не уходит убранной группе (RF-DL-10)', () => {
  it('отказ лёг в очередь, группу убрали до доставки — доставка ничего не говорит', async () => {
    const root = tempRoot();
    const h = harness(root, { groupOutcome: 'queued' });
    const record = askGroupCall(h.ctx, 'git push');
    await decideDeferred(h.ctx, record.id, { behavior: 'deny', via: 'web' });
    expect(h.deliveries).toHaveLength(1);
    const plan = h.ctx.store.getSplitPlan('parent') as SplitPlanRecord;
    h.ctx.store.setSplitPlan({
      ...plan,
      groups: plan.groups.map((group) => ({
        ...group,
        status: 'failed',
        droppedAt: new Date().toISOString(),
      })),
    } as SplitPlanRecord);
    h.deliveries[0]!();
    expect(h.delivered).toEqual([]);
  });
});
