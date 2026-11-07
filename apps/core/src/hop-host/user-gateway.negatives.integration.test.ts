import { writeFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { createServer } from 'node:net';
import { rulesPath } from '@agentdeck/dlp/rules-file';
import type { RouteReply, RouteRequest } from '@agentdeck/stub-model';
import { afterEach, describe, expect, it } from 'vitest';
import { hopStand } from './__fixtures__/hop-stand.ts';
import { userGatewayStand, type UserGatewayStand } from './__fixtures__/user-gateway-stand.ts';

/**
 * Негативные сценарии контура (`docs/PLATFORM.ru.md` § «Негативные сценарии», сторож
 * `tools/qa/check-negative-scenarios.mjs`) на настоящем пути CLI: `state.json` панели →
 * `userRouteOf` → шлюз человека на хосте звеньев → контур (заглушка `packages/stub-model`).
 * Раньше их доказывали тесты шлюза в панели (`pipeline.integration.test.ts`); шлюз в панели снят
 * (этап 10, C3d), и доказательство переехало туда, где запрос CLI теперь идёт.
 */

let gw: UserGatewayStand | undefined;
afterEach(async () => {
  await gw?.close();
  gw = undefined;
});

const CHAT = '/corp/_s/chat/v1/chat/completions';
const MESSAGES = '/corp/_s/chat/v1/messages';

async function open(
  over: Record<string, unknown> = {},
  reply?: (request: RouteRequest) => RouteReply | undefined,
  prepare?: (appData: string) => void,
): Promise<number> {
  gw = await userGatewayStand(over, {
    ...(reply ? { reply } : {}),
    ...(prepare ? { prepare } : {}),
  });
  return gw.port;
}

/** Ответ контура на чат — тот, что дал тест; прочее — сценарию заглушки. */
const onChat =
  (answer: RouteReply) =>
  (request: RouteRequest): RouteReply | undefined =>
    request.path.endsWith('/chat/completions') ? answer : undefined;

async function ask(
  port: number,
  path: string,
  body: Record<string, unknown> | string = {},
): Promise<{ status: number; text: string; json: unknown }> {
  const anthropic = path.endsWith('/messages');
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: 'Bearer cli-own',
      ...(anthropic ? { 'anthropic-version': '2023-06-01' } : {}),
    },
    body:
      typeof body === 'string'
        ? body
        : JSON.stringify({
            model: 'stub-model',
            ...(anthropic ? { max_tokens: 64 } : {}),
            messages: [{ role: 'user', content: 'привет' }],
            ...body,
          }),
  });
  const text = await response.text();
  let json: unknown;
  try {
    json = JSON.parse(text) as unknown;
  } catch {
    json = undefined;
  }
  return { status: response.status, text, json };
}

async function deadPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', () => done()));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  await new Promise<void>((done) => server.close(() => done()));
  return port;
}

/**
 * Запрос, объявивший тело больше потолка: шлюз отвечает по заголовку, не дочитывая, и рвёт
 * приём — поэтому тело шлётся лишь началом, а ответ читается до конца загрузки (`fetch` на
 * сброшенном приёме ответа не отдаёт).
 */
function declareHuge(
  port: number,
  path: string,
  bytes: number,
  auth: Record<string, string> = { authorization: 'Bearer cli-own' },
): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        host: '127.0.0.1',
        port,
        path,
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'content-length': String(bytes),
          ...auth,
        },
      },
      (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (part: string) => (text += part));
        res.on('end', () => {
          resolve({ status: res.statusCode ?? 0, text });
          req.destroy();
        });
      },
    );
    req.on('error', reject);
    req.write('{"model":"stub-model","messages":[');
  });
}

const chunk = (delta: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
  data: {
    id: 'chatcmpl-1',
    object: 'chat.completion.chunk',
    model: 'stub-model',
    choices: [{ index: 0, delta, finish_reason: null }],
    ...extra,
  },
});

describe('шлюз человека: отказы контура названы словами', () => {
  it('401 называет ВСЕ ПЯТЬ причин: снаружи их не различить', async () => {
    const port = await open({}, onChat({ status: 401, body: { detail: 'invalid API key' } }));
    const answer = await ask(port, CHAT);
    expect(answer.status).toBe(401);
    for (const reason of [
      'неизвестен или отозван',
      'истёк по сроку',
      'исчерпал свой бюджет',
      'владельца удалили',
      'сверка владельца',
    ])
      expect(answer.text).toContain(reason);
  });

  it('402 платформы компании назван бюджетом КЛЮЧА, а не уровнем над ним', async () => {
    const port = await open({}, onChat({ status: 402, body: { detail: 'budget exceeded' } }));
    const answer = await ask(port, CHAT);
    expect(answer.status).toBe(402);
    expect(answer.text).toContain('Исчерпан бюджет ключа');
  });

  it('403 называет МОДЕЛЬ и место, где её разрешают', async () => {
    const port = await open({}, onChat({ status: 403, body: { detail: 'model not allowed' } }));
    const answer = await ask(port, CHAT);
    expect(answer.status).toBe(403);
    expect(answer.text).toContain('«stub-model»');
    expect(answer.text).toContain('админке платформы');
  });

  it('429 говорит, ЧЕРЕЗ СКОЛЬКО повторить, и повторяет ровно один раз', async () => {
    const port = await open(
      {},
      onChat({ status: 429, body: { detail: 'rate limit' }, headers: { 'retry-after': '1' } }),
    );
    const answer = await ask(port, CHAT);
    expect(answer.status).toBe(429);
    expect(answer.text).toContain('повторить через 1 с');
    expect(gw!.stand.seen).toHaveLength(2);
  });

  it('404 на чате называет ОБА чтения: модель убрали или адрес ведёт в админку', async () => {
    const port = await open({}, onChat({ status: 404, body: { detail: 'Not Found' } }));
    const answer = await ask(port, CHAT);
    expect(answer.status).toBe(404);
    expect(answer.text).toContain('между прогонами');
    expect(answer.text).toContain('на админку');
  });

  it('контур не отвечает ⇒ 502 с русской причиной, а не зависание', async () => {
    const port = await open({ baseUrl: `http://127.0.0.1:${await deadPort()}` });
    const answer = await ask(port, CHAT);
    expect(answer.status).toBe(502);
    expect(answer.text).toContain('Нет связи с контуром');
  });

  it('страница входа вместо ответа: и не поток, и не ответ модели, сырое тело не показано', async () => {
    const port = await open(
      {},
      onChat({
        status: 200,
        body: '<html><body>Войдите в корпоративную сеть</body></html>',
        headers: { 'content-type': 'text/html' },
      }),
    );
    const answer = await ask(port, MESSAGES, { stream: false });
    expect(answer.status).toBeGreaterThanOrEqual(500);
    expect(answer.text).toContain('не разбирается как ответ модели');
    expect(answer.text).not.toContain('Войдите');
  });
});

describe('шлюз человека: поток наверху и учёт', () => {
  it('клиент без потока, а наверх всё равно уходит поток; anthropic без потока получает цельное сообщение', async () => {
    const port = await open();
    const answer = await ask(port, MESSAGES, { stream: false });
    expect(answer.status).toBe(200);
    expect(gw!.sentBody()).toMatchObject({ stream: true });
    expect(answer.json).toMatchObject({ type: 'message', role: 'assistant' });
    expect(answer.text).toContain('answer 1');
  });

  it('обрыв потока посреди ответа: клиент видит ошибку, повтора нет, обрыв не удваивает учёт', async () => {
    const port = await open(
      {},
      onChat({
        sse: {
          frames: [
            chunk({ role: 'assistant', content: 'половина ответа' }),
            {
              data: {
                id: 'chatcmpl-1',
                object: 'chat.completion.chunk',
                model: 'stub-model',
                choices: [],
                usage: { prompt_tokens: 11, completion_tokens: 3, total_tokens: 14 },
              },
            },
          ],
        },
      }),
    );
    const answer = await ask(port, MESSAGES, { stream: true });
    expect(answer.text).toContain('половина ответа');
    expect(answer.text).toContain('event: error');
    expect(gw!.stand.seen).toHaveLength(1);
    const spend = await gw!.control({ op: 'spend-of', tag: 'user:corp' });
    const row = spend.ok && spend.op === 'spend-of' ? spend.spend : null;
    expect(row).toMatchObject({ input: 11, output: 3 });
  });
});

describe('шлюз человека: потолки размера', () => {
  it('тело больше 32 МБ отклоняется, не читаясь, и наверх не уходит', async () => {
    const port = await open();
    const answer = await declareHuge(port, CHAT, 33 * 1024 * 1024);
    expect(answer.status).toBe(413);
    expect(answer.text).toContain('больше 32 МБ');
    expect(gw!.stand.seen).toHaveLength(0);
  });

  it('звено DLP: тело больше потолка — тот же 413 с причиной, а не обрыв связи', async () => {
    const stand = await hopStand({ script: ['never'] });
    try {
      const reply = await stand.register({ dlp: { required: false, rulesHash: null } });
      const answer = await declareHuge(reply.port, '/v1/messages', 33 * 1024 * 1024, {
        'x-api-key': reply.placeholder,
        'anthropic-version': '2023-06-01',
      });
      expect(answer.status).toBe(413);
      expect(answer.text).toContain('слишком велико');
      expect(stand.seen).toHaveLength(0);
    } finally {
      await stand.close();
    }
  });

  it('собранный ответ больше потолка 8 МБ — отказ с советом идти потоком', async () => {
    const port = await open(
      {},
      onChat({
        sse: {
          frames: [
            chunk({ role: 'assistant', content: 'я'.repeat(5 * 1024 * 1024) }),
            chunk({ content: 'я'.repeat(5 * 1024 * 1024) }),
            { data: '[DONE]' },
          ],
        },
      }),
    );
    const answer = await ask(port, MESSAGES, { stream: false });
    expect(answer.status).toBe(413);
    expect(answer.text).toContain('больше 8 МБ');
  });
});

const BLOCK_RULE = {
  id: 'r1',
  name: 'Фамилии сотрудников',
  enabled: true,
  kind: 'terms' as const,
  terms: ['Иванов'],
  pattern: '',
  action: 'block' as const,
  label: 'ИМЯ',
};

const withBlockRule = (appData: string): void =>
  writeFileSync(rulesPath(appData), JSON.stringify({ rules: [BLOCK_RULE] }));

describe('шлюз человека: отказ по содержимому на нашей стороне', () => {
  it('правило «отклонить» на мосту останавливает запрос, и наружу он не уходит', async () => {
    const port = await open({}, undefined, withBlockRule);
    gw!.writeContour({}, { dlp: { enabled: true } });
    await gw!.apply();
    const refused = await ask(port, CHAT, {
      messages: [{ role: 'user', content: 'отчёт про Иванов' }],
    });
    expect(refused.status).toBe(400);
    expect(refused.text).toContain('Фамилии сотрудников');
    expect(refused.text).not.toContain('отчёт про Иванов');
    expect(gw!.stand.seen).toHaveLength(0);
  });

  it('правило «отклонить» на родной ручке — 400 invalid_request_error, наверх ничего', async () => {
    const native = { driver: 'openai-compat', manifest: { anthropicMessages: 'messages' } };
    const port = await open(native, undefined, withBlockRule);
    gw!.writeContour(native, { dlp: { enabled: true } });
    await gw!.apply();
    const refused = await ask(port, MESSAGES, {
      stream: false,
      messages: [{ role: 'user', content: 'отчёт про Иванов' }],
    });
    expect(refused.status).toBe(400);
    expect(refused.json).toMatchObject({ error: { type: 'invalid_request_error' } });
    expect(refused.text).toContain('Фамилии сотрудников');
    expect(gw!.stand.seen).toHaveLength(0);
  });
});
