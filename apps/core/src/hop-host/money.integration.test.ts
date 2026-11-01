import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { HopRegisterSpec } from '@agentdeck/contracts/core/hops';
import type { RouteReply, RouteRequest } from '@agentdeck/stub-model';
import { priceOf } from '../economy/price/index.ts';
import { registerTag, spendOf } from '../routes/hops/hops.ts';
import { anthropicBody, ask, hopStand, type HopStand } from './__fixtures__/hop-stand.ts';

/**
 * Деньги в расходе метки (P127) на настоящем пути: регистрация клиентом ядра (`registerTag`),
 * запрос CLI в звено, ответ подставного контура с расходом и кэшем (пять минут и час), учёт
 * хоста и строка на диске. Ожидаемая сумма — из `economy/price` ядра по тем же числам: звено
 * обязано сходиться с ядром, а не со своей копией формулы.
 */

let stand: HopStand | undefined;
afterEach(async () => {
  await stand?.close().catch(() => undefined);
  stand = undefined;
});

const MONEY = { value: { unit: 'money' as const, source: 'table' } };
const MODEL = 'claude-sonnet-4-5';

/** Расход ответа, который отдаёт контур: свежий вход, чтение, запись (из неё час), выход. */
const USAGE = { input: 500, cacheRead: 2_000, cacheWrite: 300, cacheWrite1h: 100, output: 75 };

/** Цельный ответ Anthropic с разбивкой записи кэша — для DLP-звена (тот же диалект). */
function anthropicReply(model: string): RouteReply {
  return {
    body: {
      id: 'msg_1',
      type: 'message',
      role: 'assistant',
      model,
      content: [{ type: 'text', text: 'ok' }],
      stop_reason: 'end_turn',
      usage: {
        input_tokens: USAGE.input,
        output_tokens: USAGE.output,
        cache_read_input_tokens: USAGE.cacheRead,
        cache_creation_input_tokens: USAGE.cacheWrite,
        cache_creation: {
          ephemeral_5m_input_tokens: USAGE.cacheWrite - USAGE.cacheWrite1h,
          ephemeral_1h_input_tokens: USAGE.cacheWrite1h,
        },
      },
    },
  };
}

/**
 * Поток OpenAI chat с расходом LiteLLM — для шлюза (мост всегда просит поток наверху):
 * `prompt_tokens` = свежий вход + прочитанное + записанное (замер 22.10 в `cache-usage.ts`).
 */
function openAiReply(model: string): RouteReply {
  const chunk = (delta: Record<string, unknown>, finish: string | null) => ({
    id: 'c1',
    object: 'chat.completion.chunk',
    model,
    choices: [{ index: 0, delta, finish_reason: finish }],
  });
  return {
    sse: {
      frames: [
        { data: chunk({ role: 'assistant', content: 'ok' }, null) },
        { data: chunk({}, 'stop') },
        {
          data: {
            id: 'c1',
            object: 'chat.completion.chunk',
            model,
            choices: [],
            usage: {
              prompt_tokens: USAGE.input + USAGE.cacheRead + USAGE.cacheWrite,
              completion_tokens: USAGE.output,
              total_tokens: USAGE.input + USAGE.cacheRead + USAGE.cacheWrite + USAGE.output,
              prompt_tokens_details: { cached_tokens: USAGE.cacheRead },
              cache_creation_input_tokens: USAGE.cacheWrite,
              cache_creation: { ephemeral_1h_input_tokens: USAGE.cacheWrite1h },
            },
          },
        },
        { data: '[DONE]' },
      ],
    },
  };
}

const HOPS = [
  { name: 'DLP-звено', to: 'anthropic-messages' as const, reply: anthropicReply },
  { name: 'шлюз', to: 'openai-chat' as const, reply: openAiReply },
];

function replyFor(make: (model: string) => RouteReply) {
  return (request: RouteRequest): RouteReply | undefined =>
    request.path.endsWith('/messages') || request.path.endsWith('/completions')
      ? make(typeof request.body?.model === 'string' ? request.body.model : 'none')
      : undefined;
}

function spec(stand: HopStand, over: Partial<HopRegisterSpec>): HopRegisterSpec {
  return {
    tag: 'task-m.s1',
    sessionId: 'session-m',
    routeId: 'route-paid',
    upstream: stand.stub.baseUrl,
    from: 'anthropic-messages',
    to: 'anthropic-messages',
    keyRef: null,
    dlp: { required: false, rulesHash: null },
    features: [],
    ...over,
  };
}

describe('деньги в расходе метки (P127)', () => {
  for (const hop of HOPS) {
    it(`P127 ${hop.name}: маршрут с ценой → деньги строки = цена ядра той же версии, строка на диске их несёт`, async () => {
      stand = await hopStand({ script: ['never'], reply: replyFor(hop.reply) });
      const reply = await registerTag(
        stand.handle,
        spec(stand, { to: hop.to, price: { route: MONEY } }),
      );
      const body = { ...anthropicBody('x'), model: MODEL };
      expect((await ask(reply.port, reply.placeholder, 'anthropic', body)).status).toBe(200);
      expect((await ask(reply.port, reply.placeholder, 'anthropic', body)).status).toBe(200);

      const core = priceOf(MONEY, MODEL, USAGE, Date.now());
      if (core.unit !== 'money') throw new Error(`core has no money for ${MODEL}`);
      expect(core.usd).toBeGreaterThan(0);
      const spend = await spendOf(stand.handle, 'task-m.s1');
      expect(spend).toMatchObject({
        input: USAGE.input * 2,
        cacheRead: USAGE.cacheRead * 2,
        cacheWrite: USAGE.cacheWrite * 2,
        output: USAGE.output * 2,
        moneyReason: null,
        priceVersions: { [core.version]: 2 },
      });
      expect(spend?.money).toBeCloseTo(core.usd * 2, 12);

      stand.host.ctx.spend.flush();
      const file = JSON.parse(
        readFileSync(join(stand.home, 'spend', 'task-m.s1.json'), 'utf8'),
      ) as { money: number | null };
      expect(file.money).toBeCloseTo(core.usd * 2, 12);
    });
  }

  it('P127 шлюз: запись в кэш из prompt_tokens не считается ещё и свежим входом', async () => {
    stand = await hopStand({ script: ['never'], reply: replyFor(openAiReply) });
    const reply = await registerTag(stand.handle, spec(stand, { to: 'openai-chat' }));
    const body = { ...anthropicBody('x'), model: MODEL };
    expect((await ask(reply.port, reply.placeholder, 'anthropic', body)).status).toBe(200);
    expect(await spendOf(stand.handle, 'task-m.s1')).toMatchObject({
      input: USAGE.input,
      cacheRead: USAGE.cacheRead,
      cacheWrite: USAGE.cacheWrite,
    });
  });

  it('P127 модель без строки прайса → деньги null с причиной, запасной цены нет', async () => {
    stand = await hopStand({ script: ['never'], reply: replyFor(anthropicReply) });
    const reply = await registerTag(stand.handle, spec(stand, { price: { route: MONEY } }));
    const body = { ...anthropicBody('x'), model: 'qwen3-coder-local' };
    expect((await ask(reply.port, reply.placeholder, 'anthropic', body)).status).toBe(200);
    const spend = await spendOf(stand.handle, 'task-m.s1');
    expect(spend).toMatchObject({ input: USAGE.input, output: USAGE.output });
    expect(spend?.money).toBeNull();
    expect(spend?.moneyReason).toBe('unknown-price');
    expect(spend?.priceVersions).toEqual({});
  });

  it('P127 регистрация без цены (прежний вызов) → деньги null с причиной no-price-fact', async () => {
    stand = await hopStand({ script: ['never'], reply: replyFor(anthropicReply) });
    const reply = await registerTag(stand.handle, spec(stand, {}));
    const body = { ...anthropicBody('x'), model: MODEL };
    expect((await ask(reply.port, reply.placeholder, 'anthropic', body)).status).toBe(200);
    expect(await spendOf(stand.handle, 'task-m.s1')).toMatchObject({
      money: null,
      moneyReason: 'no-price-fact',
    });
  });

  it('P127 одна дыра в цене — сумма метки пуста навсегда, причина первой дыры', async () => {
    stand = await hopStand({ script: ['never'], reply: replyFor(anthropicReply) });
    const reply = await registerTag(stand.handle, spec(stand, { price: { route: MONEY } }));
    const priced = { ...anthropicBody('x'), model: MODEL };
    const unpriced = { ...anthropicBody('x'), model: 'qwen3-coder-local' };
    expect((await ask(reply.port, reply.placeholder, 'anthropic', priced)).status).toBe(200);
    expect((await spendOf(stand.handle, 'task-m.s1'))?.money).toBeGreaterThan(0);
    expect((await ask(reply.port, reply.placeholder, 'anthropic', unpriced)).status).toBe(200);
    expect((await ask(reply.port, reply.placeholder, 'anthropic', priced)).status).toBe(200);
    expect(await spendOf(stand.handle, 'task-m.s1')).toMatchObject({
      money: null,
      moneyReason: 'unknown-price',
    });
  });
});
