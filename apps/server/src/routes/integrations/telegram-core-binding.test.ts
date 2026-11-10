import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { telegramCoreBindingViewSchema } from '@agentdeck/contracts/core/telegram-channel';
import type { ServerContext } from '../../context.ts';
import type { CoreAskButtons } from '../../domains/notify/telegram-answers/core-asks-runtime.ts';
import { AppStore } from '../../lib/app-store/app-store.ts';
import {
  registerTelegramAnswersRoutes,
  type TelegramAnswersRouteDeps,
} from './telegram-answers-routes.ts';

/**
 * Ответ `GET …/answers/core-binding` на настоящем маршруте сверяется ОДНОЙ схемой контрактов
 * (этап 12, W2-D F2): окно панели читает тот же тип, строгая схема ловит лишнее или переименованное
 * поле. Подменены только кнопки ядра (чтение ядра — граница процесса) и Bot API (сеть).
 */

const FP = 'b'.repeat(64);

describe('core-binding answer against the shared contract schema (stage 12, W2-D F2)', () => {
  let root: string;
  let app: FastifyInstance;
  let ctx: ServerContext;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'cc-tg-binding-'));
    const appData = join(root, 'agentdeck');
    mkdirSync(appData, { recursive: true });
    ctx = {
      store: new AppStore(appData),
      location: { paths: { root, appData } },
    } as unknown as ServerContext;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ ok: true, result: [] }), { status: 200 })),
    );
  });

  afterEach(async () => {
    await app.close();
    vi.unstubAllGlobals();
    rmSync(root, { recursive: true, force: true });
  });

  async function binding(coreAsks: CoreAskButtons | null) {
    app = Fastify();
    const deps = {
      registry: { active: () => [] },
      session: {},
      cover: { covers: () => false },
      coreAsks,
    } as unknown as TelegramAnswersRouteDeps;
    registerTelegramAnswersRoutes(app, ctx, deps);
    await app.ready();
    const reply = await app.inject({
      method: 'GET',
      url: '/api/integrations/telegram/answers/core-binding',
    });
    expect(reply.statusCode).toBe(200);
    return telegramCoreBindingViewSchema.parse(JSON.parse(reply.body));
  }

  it('no core buttons: no fingerprint, core unreachable', async () => {
    expect(await binding(null)).toEqual({
      fingerprint: null,
      bound: false,
      reachable: false,
      ownerName: '',
      listening: false,
    });
  });

  it('a bound chat: fingerprint and the core recognition pass the strict schema', async () => {
    const coreAsks = {
      fingerprint: () => FP,
      asks: { refresh: async () => undefined, covers: () => true },
      apply: async () => ({ kind: 'applied' }),
    } as unknown as CoreAskButtons;
    expect(await binding(coreAsks)).toMatchObject({
      fingerprint: FP,
      bound: true,
      reachable: true,
    });
  });
});
