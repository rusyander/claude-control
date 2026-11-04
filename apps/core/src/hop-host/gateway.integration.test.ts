import { afterEach, describe, expect, it } from 'vitest';
import { builtinRuleSet } from '@agentdeck/dlp/default-rules';
import { rulesHashOf } from '@agentdeck/dlp/rules-hash';
import { anthropicBody, ask, hopStand, type HopStand } from './__fixtures__/hop-stand.ts';

/**
 * Шлюз хоста на подставном контуре: мост Anthropic → OpenAI chat потоком и цельным телом,
 * родная ручка с возможностями маршрута, тишина наверху и отказ регистрации.
 */

let stand: HopStand | undefined;
afterEach(async () => {
  await stand?.close().catch(() => undefined);
  stand = undefined;
});

describe('шлюз хоста звеньев', () => {
  it('мост: клиент Anthropic потоком, верх OpenAI chat — кадры Anthropic с текстом контура', async () => {
    stand = await hopStand({ script: [{ text: ['bridged ', 'stream'] }] });
    const reply = await stand.register({ to: 'openai-chat' });
    expect(reply.port).toBe(stand.host.ports.gateway);
    const answer = await ask(reply.port, reply.placeholder, 'anthropic', anthropicBody('x', true));
    expect(answer.status).toBe(200);
    expect(answer.text).toContain('event: message_start');
    expect(answer.text).toContain('bridged ');
    expect(answer.text).toContain('event: message_stop');
    expect(stand.seen[0]?.path).toBe('/v1/chat/completions');
  });

  it('контур по имени под .localhost (стенд в k8s) доходит потоком — резолвер ОС не спрашивается', async () => {
    // Резолвер Windows не знает `api.localhost`: шлюз отвечал «Нет связи с контуром: fetch failed».
    stand = await hopStand({ script: [{ text: ['stand ', 'answer'] }] });
    const upstream = stand.stub.baseUrl.replace('127.0.0.1', 'stand-check.localhost');
    expect(new URL(upstream).hostname).toBe('stand-check.localhost');
    const reply = await stand.register({ to: 'openai-chat', upstream });
    const answer = await ask(reply.port, reply.placeholder, 'anthropic', anthropicBody('x', true));
    expect(answer.status).toBe(200);
    expect(answer.text).toContain('stand ');
    expect(answer.text).toContain('event: message_stop');
    expect(stand.seen[0]?.path).toBe('/v1/chat/completions');
  });

  it('родная ручка: Anthropic ↔ Anthropic с возможностью deferred-tools идёт шлюзом', async () => {
    stand = await hopStand({ script: ['native answer'] });
    const reply = await stand.register({ features: ['deferred-tools'] });
    expect(reply.port).toBe(stand.host.ports.gateway);
    const answer = await ask(reply.port, reply.placeholder, 'anthropic', anthropicBody('x'));
    expect(answer.status).toBe(200);
    expect(answer.text).toContain('native answer');
    expect(stand.seen[0]?.path).toBe('/v1/messages');
  });

  it('тишина наверху дольше stallMs → 529 клиенту Anthropic, запрос оборван', async () => {
    stand = await hopStand({
      script: [{ text: 'late', holdMs: 5_000 }],
      config: { stallMs: 300 },
    });
    const reply = await stand.register({ to: 'openai-chat' });
    const started = Date.now();
    const answer = await ask(reply.port, reply.placeholder, 'anthropic', anthropicBody('x'));
    expect(answer.status).toBe(529);
    expect(Date.now() - started).toBeLessThan(4_000);
  });

  it('регистрация: неизвестная возможность и чужой хэш правил — отказ до заглушки', async () => {
    stand = await hopStand({ script: ['never'] });
    await expect(stand.register({ features: ['teleport'] })).rejects.toMatchObject({
      code: 'unknown_feature',
    });
    await expect(
      stand.register({ dlp: { required: true, rulesHash: 'not-the-hash' } }),
    ).rejects.toMatchObject({ code: 'dlp_rules_mismatch' });
    // Хэш тех правил, что звено применит (каталог панели пуст → встроенный набор), принят.
    const ok = await stand.register({
      dlp: { required: true, rulesHash: rulesHashOf(builtinRuleSet()) },
    });
    expect(ok.placeholder).toMatch(/^adk-hop-/);
  });
});
