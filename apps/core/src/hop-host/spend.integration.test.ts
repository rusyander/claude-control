import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { clearExhausted, hopStatus, spendOf } from '../routes/hops/hops.ts';
import { anthropicBody, ask, hopStand, type HopStand } from './__fixtures__/hop-stand.ts';

/**
 * Отказы контура и расход по метке (P122) на подставном контуре: оба звена — DLP (тот же
 * диалект) и шлюз (Anthropic → OpenAI chat) — идут одним путём ключа, повтора и учёта.
 */

let stand: HopStand | undefined;
afterEach(async () => {
  await stand?.close().catch(() => undefined);
  stand = undefined;
});

const HOPS = [
  { name: 'DLP-звено', to: 'anthropic-messages' as const },
  { name: 'шлюз', to: 'openai-chat' as const },
];

function traceLines(home: string): Record<string, unknown>[] {
  const path = join(home, 'hops', 'trace.jsonl');
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe('402 — маршрут держится до человека (P122)', () => {
  for (const hop of HOPS) {
    it(`P122 ${hop.name}: 402 → маршрут исчерпан, следующий запрос до контура не идёт, снимает только clear-exhausted`, async () => {
      stand = await hopStand({ script: [{ error: { status: 402 } }, 'after clear'] });
      const reply = await stand.register({ to: hop.to });
      const first = await ask(reply.port, reply.placeholder, 'anthropic', anthropicBody('one'));
      expect(first.status).toBe(402);
      expect(stand.seen).toHaveLength(1);

      const held = await ask(reply.port, reply.placeholder, 'anthropic', anthropicBody('two'));
      expect(held.status).toBe(402);
      expect(held.text).toContain('route-stub');
      expect(stand.seen).toHaveLength(1);
      const status = await hopStatus(stand.handle);
      expect(status.exhausted.map((row) => row.routeId)).toEqual(['route-stub']);
      // Отметка на диске сразу: упавший хост не забудет её и не пойдёт в исчерпанный ключ.
      expect(readFileSync(join(stand.home, 'spend', 'exhausted.json'), 'utf8')).toContain(
        'route-stub',
      );

      expect(await clearExhausted(stand.handle, 'route-stub')).toBe(true);
      const after = await ask(reply.port, reply.placeholder, 'anthropic', anthropicBody('three'));
      expect(after.status).toBe(200);
      expect(after.text).toContain('after clear');
      expect(stand.seen).toHaveLength(2);
    });
  }
});

describe('429 — один повтор после паузы (P122)', () => {
  for (const hop of HOPS) {
    it(`P122 ${hop.name}: 429 один раз → повтор, клиент получает ответ`, async () => {
      stand = await hopStand({ script: [{ error: { status: 429 } }, 'second try'] });
      const reply = await stand.register({ to: hop.to });
      const answer = await ask(reply.port, reply.placeholder, 'anthropic', anthropicBody('x'));
      expect(answer.status).toBe(200);
      expect(answer.text).toContain('second try');
      expect(stand.seen).toHaveLength(2);
      expect(traceLines(stand.home).at(-1)).toMatchObject({ status: 200, retried: true });
    });

    it(`P122 ${hop.name}: 429 дважды → повтор ровно один, клиенту 429`, async () => {
      stand = await hopStand({
        script: [{ error: { status: 429 } }, { error: { status: 429 } }, 'never'],
      });
      const reply = await stand.register({ to: hop.to });
      const answer = await ask(reply.port, reply.placeholder, 'anthropic', anthropicBody('x'));
      expect(answer.status).toBe(429);
      expect(stand.seen).toHaveLength(2);
    });
  }
});

describe('451 — отказ назван (P122)', () => {
  it('P122 шлюз: 451 контура → отказ запроса с названием проверки, текст запроса не наружу', async () => {
    const leaked = 'the prompt piece that tripped the scanner';
    stand = await hopStand({
      script: ['never'],
      reply: (request) =>
        request.path.endsWith('/completions')
          ? {
              status: 451,
              body: {
                error: {
                  message: 'blocked',
                  violations: [{ rule_type: 'pii_scanner', matched: leaked }],
                },
              },
            }
          : undefined,
    });
    const reply = await stand.register({
      to: 'openai-chat',
      features: ['driver:enterprise-platform'],
    });
    const answer = await ask(reply.port, reply.placeholder, 'anthropic', anthropicBody('x'));
    expect(answer.status).toBe(400);
    const error = (answer.json as { error?: { code?: string; message?: string } }).error;
    expect(error?.code).toBe('content_policy_violation');
    // Название проверки — в тексте отказа, который CLI печатает человеку.
    expect(error?.message).toContain('pii_scanner');
    expect(answer.text).not.toContain(leaked);
    const last = traceLines(stand.home).at(-1);
    expect(last).toMatchObject({ code: 'content_policy_violation', violations: ['pii_scanner'] });
  });
});

describe('расход по метке (P122)', () => {
  it('P122 две метки одного маршрута считаются раздельно и сбрасываются в свои файлы', async () => {
    stand = await hopStand({
      script: {
        rules: [
          { when: 'TAG-A', step: { text: 'a', usage: { input: 10, output: 5 } } },
          { when: 'TAG-B', step: { text: 'b', usage: { input: 20, output: 7 } } },
        ],
      },
    });
    const a = await stand.register({ tag: 'task-a.s1' });
    const b = await stand.register({ tag: 'task-b.s1', to: 'openai-chat' });
    expect((await ask(a.port, a.placeholder, 'anthropic', anthropicBody('TAG-A'))).status).toBe(
      200,
    );
    expect((await ask(b.port, b.placeholder, 'anthropic', anthropicBody('TAG-B'))).status).toBe(
      200,
    );
    expect((await ask(a.port, a.placeholder, 'anthropic', anthropicBody('TAG-A'))).status).toBe(
      200,
    );
    expect(await spendOf(stand.handle, 'task-a.s1')).toMatchObject({ input: 20, output: 10 });
    expect(await spendOf(stand.handle, 'task-b.s1')).toMatchObject({ input: 20, output: 7 });
    // Денег нет без цены: токены — всегда, сумма — только при известной цене (P127).
    expect((await spendOf(stand.handle, 'task-a.s1'))?.money).toBeNull();
    stand.host.ctx.spend.flush();
    const file = JSON.parse(
      readFileSync(join(stand.home, 'spend', 'task-a.s1.json'), 'utf8'),
    ) as Record<string, unknown>;
    expect(file).toMatchObject({ tag: 'task-a.s1', input: 20, output: 10 });
  });
});
