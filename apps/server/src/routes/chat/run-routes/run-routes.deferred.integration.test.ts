import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawn } from 'node:child_process';
import Fastify, { type FastifyInstance } from 'fastify';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { deferredIdOf, isPanelRefusal } from '@agentdeck/contracts/deferred-asks';
import { AppStore } from '../../../lib/app-store/app-store.ts';
import type { ServerContext } from '../../../context.ts';
import {
  ChatRunRegistry,
  type RunLike,
} from '../../../domains/chat/ChatRunRegistry/ChatRunRegistry.ts';
import { ChatSession } from '../../../domains/chat/ChatSession/ChatSession.ts';
import { ViewerPresence } from '../../../domains/chat/ChatRunRegistry/viewer-presence.ts';
import type { ChatEvent } from '../../../domains/chat/chat-events.ts';
import { decideDeferred, deferredAsksOf } from '../deferred-routes/deferred-store.ts';
import { registerChatRunRoutes } from './run-routes.ts';

/**
 * Мост прав одиночного чата и D-n (решения владельца 23.10): карточка первой,
 * когда человек может смотреть; D-n — по сроку `deferAfterMinutes` или сразу,
 * когда чат автономный и ни один клиент его не смотрит. Разовое разрешение —
 * ровно на тот вызов. Настоящие маршрут, брокер, хранилище и запись D-n;
 * заглушен только процесс CLI.
 */
describe('мост прав одиночного чата: карточка, срок, D-n и разовое разрешение', () => {
  let root: string;
  let app: FastifyInstance;
  let ctx: ServerContext;
  let registry: ChatRunRegistry;
  let session: ChatSession;
  let events: ChatEvent[];
  let autonomous: boolean;
  /** Минуты срока карточки; дробное — только здесь, настройка целая. */
  let deferAfterMinutes: number;
  const detaches: (() => void)[] = [];
  const CHAT = 'chat-1';

  /** Номер процесса следующего «CLI» — корень прогона для `humanOnly`. */
  let nextPid: number | undefined;
  const liveRun = (): RunLike => ({
    start: () => new Promise(() => undefined),
    stop: () => undefined,
    ...(nextPid ? { pid: nextPid } : {}),
  });

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'cc-run-deferred-'));
    const appData = join(root, 'agentdeck');
    const cwd = join(root, 'work');
    mkdirSync(appData, { recursive: true });
    mkdirSync(cwd, { recursive: true });
    const store = new AppStore(appData);
    const settings = store.getSettings.bind(store);
    store.getSettings = () => ({ ...settings(), deferAfterMinutes });
    autonomous = false;
    deferAfterMinutes = 10;
    events = [];
    registry = new ChatRunRegistry(liveRun);
    registry.setAutonomyResolver(() => autonomous);
    session = new ChatSession(registry);
    ctx = {
      store,
      location: {
        paths: {
          root,
          settings: join(root, 'settings.json'),
          settingsLocal: join(root, 'settings.local.json'),
          appData,
          mcpConfig: join(root, '.claude.json'),
        },
      },
      backupDir: join(root, 'backups'),
      pricing: { current: () => ({ entries: [] }) },
      models: { current: () => ({ models: [] }) },
    } as unknown as ServerContext;
    app = Fastify();
    registerChatRunRoutes(app, ctx, registry, session);
    await app.ready();
    registry.start(CHAT, { prompt: 'задача', cwd }, { projectPath: cwd });
    // Подписка теста — служебная (не `viewer`): события видит, человеком не считается.
    detaches.push(
      registry.attach(CHAT, 0, {
        send: ({ event }) => void events.push(event),
        close: () => undefined,
      }) as () => void,
    );
  });

  afterEach(async () => {
    for (const detach of detaches.splice(0)) detach();
    registry.stopAll();
    await app.close();
    rmSync(root, { recursive: true, force: true });
  });

  /**
   * Панель поднята давно и человек разговор не открывал: окно «только что после
   * старта» прошло, автономный чат без потока — без присмотра.
   */
  const unwatchedPanel = (): void => {
    Object.assign(registry, { viewers: new ViewerPresence(0) });
  };

  /** Вкладка человека: поток клиента, как у `ChatStream`. */
  const openTab = (): void => {
    detaches.push(
      registry.attach(CHAT, 0, {
        send: () => undefined,
        close: () => undefined,
        viewer: true,
      }) as () => void,
    );
  };

  const hasCard = (toolUseId: string): boolean =>
    events.some(
      (event) =>
        event.kind === 'permission' && (event as { toolUseId?: string }).toolUseId === toolUseId,
    );

  /** Ответ моста как его увидит CLI, и была ли до него карточка. */
  const ask = async (
    command: string,
    toolUseId: string,
    { waitCard = false }: { waitCard?: boolean } = {},
  ): Promise<{ outcome: string; card: boolean; message: string }> => {
    const pending = app.inject({
      method: 'POST',
      url: '/api/chat/permission-request',
      payload: { runId: CHAT, toolName: 'Bash', input: { command }, toolUseId },
    });
    let settled: { behavior: string; message?: string } | undefined;
    void pending.then((res) => (settled = res.json()));
    const deadline = Date.now() + 10_000;
    while (!settled && !(hasCard(toolUseId) && !waitCard) && Date.now() < deadline) {
      await new Promise((done) => setTimeout(done, 10));
    }
    const card = hasCard(toolUseId);
    if (!settled) {
      session.abort(CHAT);
      await pending;
      return { outcome: card ? 'card' : 'pending', card, message: '' };
    }
    const message = settled.message ?? '';
    const outcome =
      settled.behavior === 'deny' && deferredIdOf(message)
        ? 'deferred'
        : settled.behavior === 'deny' && isPanelRefusal(message)
          ? 'refused'
          : settled.behavior;
    return { outcome, card, message };
  };

  it('чат не автономный — карточка первой; срок истёк — она сама становится D-n', async () => {
    deferAfterMinutes = 0.002;
    const result = await ask('rm -rf build', 'toolu_attended', { waitCard: true });
    expect(result).toMatchObject({ outcome: 'deferred', card: true });
    const id = deferredIdOf(result.message)!;
    expect(deferredAsksOf(ctx).get(id)?.state).toBe('waiting');
    expect(
      events.find((event) => event.kind === 'permissionResolved') as { deferredId?: string },
    ).toMatchObject({ deferredId: id });
  });

  it('автономный чат, ни одного клиента — D-n сразу, карточки нет', async () => {
    autonomous = true;
    // Окно срока 120 мс, панель старше него: человека нет и не было.
    deferAfterMinutes = 0.002;
    await new Promise((done) => setTimeout(done, 200));
    const result = await ask('rm -rf build', 'toolu_alone');
    expect(result).toMatchObject({ outcome: 'deferred', card: false });
  });

  it('панель только что поднялась, вкладка ещё переподключается — карточка первой', async () => {
    autonomous = true;
    const result = await ask('rm -rf build', 'toolu_reboot');
    expect(result).toMatchObject({ outcome: 'card', card: true });
    expect(deferredAsksOf(ctx).all()).toEqual([]);
  });

  it('вкладку закрыли только что — карточка; закрыли раньше окна — D-n сразу', async () => {
    autonomous = true;
    deferAfterMinutes = 0.002;
    await new Promise((done) => setTimeout(done, 200));
    openTab();
    detaches.pop()?.();
    const fresh = await ask('rm -rf build', 'toolu_closed_now');
    expect(fresh).toMatchObject({ card: true });
    await new Promise((done) => setTimeout(done, 200));
    const stale = await ask('rm -rf dist', 'toolu_closed_long_ago');
    expect(stale).toMatchObject({ outcome: 'deferred', card: false });
  });

  it('автономный чат, открыта вкладка — карточка первой, D-n только по сроку', async () => {
    autonomous = true;
    openTab();
    const waiting = await ask('rm -rf build', 'toolu_watched');
    expect(waiting).toMatchObject({ outcome: 'card', card: true });
    expect(deferredAsksOf(ctx).all()).toEqual([]);
    deferAfterMinutes = 0.002;
    const later = await ask('rm -rf dist', 'toolu_watched_2', { waitCard: true });
    expect(later).toMatchObject({ outcome: 'deferred', card: true });
  });

  it('срок ноль — карточка ждёт человека, D-n не заводится', async () => {
    deferAfterMinutes = 0;
    const result = await ask('rm -rf build', 'toolu_never');
    expect(result).toMatchObject({ outcome: 'card' });
    await new Promise((done) => setTimeout(done, 200));
    expect(deferredAsksOf(ctx).all()).toEqual([]);
  });

  it('разрешение человека — ровно тот вызов и один раз; соседний вызов и повтор — снова к человеку', async () => {
    autonomous = true;
    unwatchedPanel();
    const first = await ask('rm -rf build', 'toolu_g1');
    const id = deferredIdOf(first.message)!;
    // Пока ждёт — повтор не заводит новой записи.
    const retry = await ask('rm -rf build', 'toolu_g2');
    expect(deferredIdOf(retry.message)).toBe(id);
    expect(retry.message).toMatch(/already queued/i);
    await decideDeferred(ctx, id, { behavior: 'allow', via: 'web' });
    const near = await ask('rm -rf build ./src', 'toolu_g3');
    expect(near.outcome).toBe('deferred');
    expect(deferredIdOf(near.message)).not.toBe(id);
    const exact = await ask('rm -rf build', 'toolu_g4');
    expect(exact.outcome).toBe('allow');
    const again = await ask('rm -rf build', 'toolu_g5');
    expect(again.outcome).toBe('deferred');
    expect(deferredIdOf(again.message)).not.toBe(id);
  });

  it('отказ человека — повтор того же вызова получает его слово, записи не прибавляется', async () => {
    autonomous = true;
    unwatchedPanel();
    const first = await ask('rm -rf build', 'toolu_d1');
    const id = deferredIdOf(first.message)!;
    await decideDeferred(ctx, id, { behavior: 'deny', message: 'не трогать', via: 'web' });
    const retry = await ask('rm -rf build', 'toolu_d2');
    expect(retry.message).toContain(`refused ${id}: не трогать`);
    expect(deferredAsksOf(ctx).all()).toHaveLength(1);
  });

  it('карточка, ставшая D-n по сроку: её кнопки решают запись, CLI уже не ждёт', async () => {
    deferAfterMinutes = 0.002;
    const result = await ask('rm -rf build', 'toolu_card', { waitCard: true });
    const id = deferredIdOf(result.message)!;
    const answered = await app.inject({
      method: 'POST',
      url: `/api/chat/${CHAT}/permission-decision`,
      payload: { toolUseId: 'toolu_card', behavior: 'allow' },
    });
    expect(answered.json()).toMatchObject({
      ok: true,
      deferred: { item: { id, state: 'allowed' } },
    });
    expect(deferredAsksOf(ctx).get(id)?.state).toBe('allowed');
  });

  it('карточку прав процесс модели не решает: настоящий сокет, ребёнок прогона — 403', async () => {
    await app.close();
    app = Fastify();
    registerChatRunRoutes(app, ctx, registry, session);
    await app.listen({ port: 0, host: '127.0.0.1' });
    const port = (app.server.address() as { port: number }).port;
    const request = `fetch('http://127.0.0.1:${port}/api/chat/${CHAT}/permission-decision', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ toolUseId: 'toolu_x', behavior: 'allow' }) }).then(async (r) => { console.log(JSON.stringify({ status: r.status, body: await r.json() })); process.exit(0); }, (e) => { console.log(JSON.stringify({ status: 0, body: String(e) })); process.exit(0); });`;
    const cli = spawn(
      process.execPath,
      [
        '-e',
        `const c = require('child_process').spawn(process.execPath, ['-e', ${JSON.stringify(request)}], { stdio: ['ignore', 'inherit', 'ignore'] }); c.on('exit', () => process.exit(0)); setInterval(() => {}, 1000);`,
      ],
      { stdio: ['ignore', 'pipe', 'ignore'] },
    );
    // Его прогон — в реестре до того, как ребёнок успеет подняться.
    nextPid = cli.pid;
    registry.start('model-run', { prompt: 'x', cwd: root }, {});
    nextPid = undefined;
    const reply = await new Promise<{ status: number; body: { code?: string } }>((done) => {
      let out = '';
      cli.stdout?.on('data', (chunk: Buffer) => (out += String(chunk)));
      cli.on('exit', () => done(JSON.parse(out.trim().split(/\r?\n/).at(-1) ?? '{}')));
    });
    expect(reply).toMatchObject({ status: 403, body: { code: 'decision_human_only' } });
  }, 60_000);

  it('ответить за человека через панель и слить в main — отказ с известным ответом, не D-n', async () => {
    autonomous = true;
    unwatchedPanel();
    const self = await ask(
      'curl -X POST http://127.0.0.1:5178/api/chat/deferred/D-1/decision -d \'{"behavior":"allow"}\'',
      'toolu_self',
    );
    expect(self.outcome).toBe('refused');
    const merge = await ask('gh pr merge 5 --squash', 'toolu_merge');
    expect(merge.outcome).toBe('refused');
    expect(deferredAsksOf(ctx).all()).toEqual([]);
  });

  /**
   * Близнецы (RF-DL-02, живой A8): модель шлёт один и тот же вызов дважды в
   * одном ответе — две карточки разом. Вызов один, и решение одно: ответ на одну
   * карточку закрывает и вторую, второй раз вызов не исполнится.
   */
  describe('близнецы вызова: две карточки одного вызова (RF-DL-02)', () => {
    const TWIN = 'npm publish --access public';

    /** Запрос моста без обрыва: ответ CLI придёт, когда придёт. */
    const bridge = (toolUseId: string) => {
      type Reply = { behavior: string; message?: string };
      let settled: Reply | undefined;
      const done = app
        .inject({
          method: 'POST',
          url: '/api/chat/permission-request',
          payload: { runId: CHAT, toolName: 'Bash', input: { command: TWIN }, toolUseId },
        })
        .then((res): Reply => {
          settled = res.json<Reply>();
          return settled;
        });
      return { done, settled: () => settled };
    };
    const until = async (ok: () => boolean): Promise<void> => {
      const deadline = Date.now() + 10_000;
      while (!ok() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 5));
    };
    const card = (toolUseId: string, behavior: 'allow' | 'deny') =>
      app.inject({
        method: 'POST',
        url: `/api/chat/${CHAT}/permission-decision`,
        payload: { toolUseId, behavior },
      });

    for (const behavior of ['allow', 'deny'] as const) {
      it(`одну карточку решили (${behavior}) — срок второй даёт отказ без новой D-n`, async () => {
        deferAfterMinutes = 0.01;
        const a = bridge('toolu_twin_a');
        await until(() => hasCard('toolu_twin_a'));
        const b = bridge('toolu_twin_b');
        await until(() => hasCard('toolu_twin_b'));
        await card('toolu_twin_b', behavior);
        expect((await b.done).behavior).toBe(behavior);
        const late = await a.done;
        expect(late.behavior).toBe('deny');
        expect(deferredIdOf(late.message ?? '')).toBeUndefined();
        expect(late.message).toContain(behavior === 'allow' ? 'already made once' : 'refused');
        expect(deferredAsksOf(ctx).all()).toEqual([]);
      }, 30_000);
    }

    it('первая стала D-n по сроку, потом вторую разрешили с карточки — D-n закрыта, позднее «Разрешить» ничего не исполнит', async () => {
      deferAfterMinutes = 0.01;
      const a = bridge('toolu_twin_c');
      await until(() => hasCard('toolu_twin_c'));
      await new Promise((r) => setTimeout(r, 250));
      const b = bridge('toolu_twin_d');
      await until(() => hasCard('toolu_twin_d'));
      const early = await a.done;
      const id = deferredIdOf(early.message ?? '')!;
      expect(id).toBeTruthy();
      expect(b.settled()).toBeUndefined();
      await card('toolu_twin_d', 'allow');
      expect((await b.done).behavior).toBe('allow');
      expect(deferredAsksOf(ctx).get(id)?.state).toBe('consumed');
      const late = await decideDeferred(ctx, id, { behavior: 'allow', via: 'web' });
      expect(late?.changed).toBe(false);
      expect(late?.resume).toBeUndefined();
    }, 30_000);
  });
});
