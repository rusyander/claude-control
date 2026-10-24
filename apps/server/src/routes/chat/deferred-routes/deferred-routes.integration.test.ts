import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import Fastify, { type FastifyInstance } from 'fastify';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AppStore } from '../../../lib/app-store/app-store.ts';
import type { ServerContext } from '../../../context.ts';
import type { DeferredAskRecord } from '../../../domains/chat/deferred-asks/deferred-asks.ts';
import { CLIENT_PORT_HEADER } from '../human-only/human-only.ts';
import { registerDeferredRoutes } from './deferred-routes.ts';
import { deferredAsksOf, setDeferredResumer } from './deferred-store.ts';

/**
 * Решение D-n — только от человека (решение 3): настоящий маршрут на настоящем
 * сокете loopback, настоящие таблицы TCP и процессов ОС. «Прогон модели» — живой
 * процесс node, его ребёнок шлёт решение тем же `fetch`, что модель через
 * `node -e` или `curl`. Сам процесс теста по сокету — НЕ человек (RF-DS-05:
 * не браузер, а доверия «соседу» больше нет). Человек здесь — вызов изнутри
 * панели (`app.inject`: Telegram, агент панели); живой браузер владельца —
 * в `tools/qa/check-deferred-human-gate.mjs`.
 */

interface Reply {
  status: number;
  body: { code?: string; item?: { state?: string }; changed?: boolean; resume?: string };
}

describe('маршрут решения D-n: человек — да, процесс модели — нет', () => {
  let root: string;
  let app: FastifyInstance;
  let ctx: ServerContext;
  let port = 0;
  /** Номера «корней прогонов» — то, что реестр отдал бы `humanOnly`. */
  let roots: number[] = [];
  const pids: number[] = [];

  afterAll(() => {
    for (const pid of pids) {
      try {
        process.kill(pid);
      } catch {
        // уже вышел
      }
    }
  });

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'cc-deferred-routes-'));
    const appData = join(root, 'agentdeck');
    mkdirSync(appData, { recursive: true });
    ctx = {
      store: new AppStore(appData),
      location: { paths: { root, appData } },
    } as unknown as ServerContext;
    roots = [];
    app = Fastify();
    registerDeferredRoutes(app, ctx, { allProcessRoots: () => roots });
    await app.listen({ port: 0, host: '127.0.0.1' });
    port = (app.server.address() as { port: number }).port;
  });

  afterEach(async () => {
    await app.close();
    rmSync(root, { recursive: true, force: true });
  });

  const seed = (): DeferredAskRecord => {
    const outcome = deferredAsksOf(ctx).ask({
      scope: { kind: 'group', parentChatId: 'parent', groupIndex: 0 },
      runKeys: ['group-chat'],
      toolName: 'Bash',
      input: { command: 'psql -c "DROP TABLE users"' },
      toolUseId: 'toolu_1',
      reason: 'row database',
    });
    return outcome.record;
  };

  /**
   * Решение из-под «прогона»: корень спит, его ребёнок шлёт запрос и печатает
   * ответ. Корень — в `roots`, как CLI, запущенный панелью.
   */
  const fromModel = async (
    id: string,
    headers: Record<string, string> = {},
    body: Record<string, string> = { behavior: 'allow' },
  ): Promise<Reply> => {
    const request = `fetch('http://127.0.0.1:${port}/api/chat/deferred/${id}/decision', { method: 'POST', headers: ${JSON.stringify(
      { 'content-type': 'application/json', ...headers },
    )}, body: ${JSON.stringify(JSON.stringify(body))} }).then(async (r) => { console.log(JSON.stringify({ status: r.status, body: await r.json() })); process.exit(0); }, (e) => { console.log(JSON.stringify({ status: 0, body: { code: String(e) } })); process.exit(0); });`;
    const cli = spawn(
      process.execPath,
      [
        '-e',
        `const c = require('child_process').spawn(process.execPath, ['-e', ${JSON.stringify(request)}], { stdio: ['ignore', 'inherit', 'ignore'] }); c.on('exit', () => process.exit(0)); setInterval(() => {}, 1000);`,
      ],
      { stdio: ['ignore', 'pipe', 'ignore'] },
    );
    if (cli.pid) {
      pids.push(cli.pid);
      roots.push(cli.pid);
    }
    return new Promise<Reply>((done) => {
      let out = '';
      cli.stdout?.on('data', (chunk: Buffer) => (out += String(chunk)));
      // Пустой вывод (процесс убит под нагрузкой) — провал проверки с причиной,
      // а не необработанное исключение, роняющее весь прогон.
      cli.on('exit', (code, signal) => {
        const last = out.trim().split(/\r?\n/).at(-1);
        done(
          last
            ? (JSON.parse(last) as Reply)
            : { status: -1, body: { code: `no output (exit ${code}, ${signal})` } },
        );
      });
    });
  };

  const fromSocket = async (id: string, behavior: 'allow' | 'deny' = 'allow'): Promise<Reply> => {
    const response = await fetch(`http://127.0.0.1:${port}/api/chat/deferred/${id}/decision`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ behavior }),
    });
    return { status: response.status, body: (await response.json()) as Reply['body'] };
  };

  /** Вызов изнутри панели — сокета нет (Telegram, агент панели). */
  const fromInside = async (id: string, behavior: 'allow' | 'deny' = 'allow'): Promise<Reply> => {
    const response = await app.inject({
      method: 'POST',
      url: `/api/chat/deferred/${id}/decision`,
      payload: { behavior },
    });
    return { status: response.statusCode, body: response.json() as Reply['body'] };
  };

  it('процесс под прогоном отвечает на свой D-n — 403, запись ждёт; заголовки прокси и XFF не помогают', async () => {
    const record = seed();
    const plain = await fromModel(record.id);
    expect(plain).toMatchObject({ status: 403, body: { code: 'decision_human_only' } });
    const forged = await fromModel(record.id, {
      [CLIENT_PORT_HEADER]: '1',
      'x-forwarded-for': '127.0.0.1',
    });
    expect(forged).toMatchObject({ status: 403, body: { code: 'decision_human_only' } });
    // `via` — подпись, не право: «из Telegram» в теле от процесса модели ничего не даёт.
    const labelled = await fromModel(record.id, {}, { behavior: 'allow', via: 'telegram' });
    expect(labelled).toMatchObject({ status: 403, body: { code: 'decision_human_only' } });
    expect(deferredAsksOf(ctx).get(record.id)?.state).toBe('waiting');
  }, 60_000);

  it('не браузер по сокету (сам процесс теста, помощник вне прогона) — 403, запись ждёт', async () => {
    const record = seed();
    const refused = await fromSocket(record.id);
    expect(refused).toMatchObject({ status: 403, body: { code: 'decision_device_unverified' } });
    expect(deferredAsksOf(ctx).get(record.id)?.state).toBe('waiting');
  }, 60_000);

  it('вызов изнутри панели — решение принято, повтор ничего не меняет и не продолжает дважды', async () => {
    const resumed: string[] = [];
    setDeferredResumer(ctx, async (record) => {
      resumed.push(record.id);
      return 'sent';
    });
    const record = seed();
    // Прогон жив и в `roots` — вызов изнутри панели всё равно принят.
    void fromModel('D-999');
    const first = await fromInside(record.id);
    expect(first).toMatchObject({
      status: 200,
      body: { changed: true, resume: 'sent', item: { state: 'allowed' } },
    });
    const again = await fromInside(record.id, 'deny');
    expect(again).toMatchObject({ status: 200, body: { changed: false } });
    expect(resumed).toEqual([record.id]);
    // «Сказано» помечает продолжатель по факту доставки (`deferred-wiring.ts`
    // `onSent`), а не решение: заглушка здесь не помечает (RF-DL-01/04).
    expect(deferredAsksOf(ctx).get(record.id)?.toldAt).toBeUndefined();
    const missing = await fromInside('D-404');
    expect(missing).toMatchObject({ status: 404, body: { code: 'deferred_not_found' } });
  }, 60_000);

  it('список отдаётся всем, новые сверху', async () => {
    const first = seed();
    deferredAsksOf(ctx).ask({
      scope: { kind: 'chat', chatKeys: ['c1'] },
      runKeys: ['c1'],
      toolName: 'Bash',
      input: { command: 'npm publish' },
      reason: 'publish',
    });
    const response = await fetch(`http://127.0.0.1:${port}/api/chat/deferred`);
    const list = (await response.json()) as { items: Array<{ id: string }> };
    expect(list.items.map((item) => item.id).at(-1)).toBe(first.id);
    expect(list.items).toHaveLength(2);
  });
});
