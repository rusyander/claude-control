import { describe, expect, it, afterEach, beforeEach } from 'vitest';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DlpRule } from '@claude-control/contracts';
import { DlpProxy, joinUpstream } from './DlpProxy.ts';
import { readJournal, clearJournal, appendJournal } from './journal.ts';
import { readRules, saveRules, validateRules, DlpRulesError } from './rules-store.ts';

/**
 * Сквозные проверки прокси: настоящий сокет, настоящий «верхний» сервер.
 *
 * Мокать здесь нечего — вся суть в том, что уходит по проводу: подменять fetch
 * значило бы проверять собственную заглушку, а не то, увидит ли модель фамилию.
 */

/**
 * Порты берём свободные, а не фиксированные. Пара 5391/5392 переживала 22
 * цикла «поднять — погасить» на одном и том же номере, и в полном параллельном
 * прогоне это регулярно давало ECONNRESET на ровном месте: соединение уходило в
 * сокет, который только что закрыли и открыли заново. Продукт тут ни при чём —
 * это гигиена самого стенда, но красный прогон выглядит одинаково.
 */
async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const address = probe.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return port;
}

function rule(patch: Partial<DlpRule> & Pick<DlpRule, 'id' | 'name'>): DlpRule {
  return {
    enabled: true,
    kind: 'terms',
    terms: [],
    pattern: '',
    action: 'mask',
    label: 'ДАННЫЕ',
    ...patch,
  };
}

const NAMES = rule({
  id: 'names',
  name: 'Сотрудники',
  kind: 'terms',
  terms: ['Рустам Урманов'],
  label: 'ИМЯ',
});

const SECRETS = rule({
  id: 'secrets',
  name: 'Ключи',
  kind: 'regex',
  pattern: 'sk-[a-z0-9]{6,}',
  action: 'block',
});

describe('DlpProxy', () => {
  let proxy: DlpProxy;
  let upstream: Server;
  let seen: { path: string; body: string; headers: Record<string, string> }[];
  let reply: { status: number; type: string; body: string };
  let dir: string;
  let PORT: number;
  let UPSTREAM_PORT: number;

  beforeEach(async () => {
    PORT = await freePort();
    UPSTREAM_PORT = await freePort();
    dir = mkdtempSync(join(tmpdir(), 'dlp-proxy-'));
    seen = [];
    reply = { status: 200, type: 'application/json', body: '{"ok":true}' };

    upstream = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => chunks.push(chunk));
      request.on('end', () => {
        seen.push({
          path: request.url ?? '',
          body: Buffer.concat(chunks).toString('utf8'),
          headers: request.headers as Record<string, string>,
        });
        response.writeHead(reply.status, { 'content-type': reply.type });
        response.end(reply.body);
      });
    });
    await new Promise<void>((resolve) => upstream.listen(UPSTREAM_PORT, '127.0.0.1', resolve));

    proxy = new DlpProxy();
  });

  afterEach(async () => {
    await proxy.stop();
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
    rmSync(dir, { recursive: true, force: true });
  });

  const start = (patch: Partial<Parameters<DlpProxy['start']>[0]> = {}) =>
    proxy.start({
      port: PORT,
      upstream: `http://127.0.0.1:${UPSTREAM_PORT}`,
      rules: [NAMES, SECRETS],
      passUnknown: false,
      journal: true,
      appDataDir: dir,
      ...patch,
    });

  const post = (path: string, body: string, headers: Record<string, string> = {}) =>
    fetch(`http://127.0.0.1:${PORT}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body,
    });

  it('поднимается только на петлевом интерфейсе', async () => {
    await start();
    const status = proxy.status();
    expect(status.running).toBe(true);
    expect(status.address).toBe(`http://127.0.0.1:${PORT}`);
  });

  it('заменяет найденное на метку — наверх уходит уже без фамилии', async () => {
    await start();
    await post(
      '/v1/messages',
      JSON.stringify({ messages: [{ role: 'user', content: 'спроси у Рустама Урманова' }] }),
    );

    const sent = seen[0]?.body ?? '';
    expect(sent).not.toContain('Урманов');
    expect(sent).toContain('[ИМЯ_1]');
  });

  it('возвращает метку обратно в ответе — человек видит настоящее имя', async () => {
    await start();
    await post(
      '/v1/messages',
      JSON.stringify({ messages: [{ role: 'user', content: 'Рустам Урманов' }] }),
    );

    reply.body = JSON.stringify({
      id: 'msg_1',
      content: [{ type: 'text', text: 'готово, [ИМЯ_1]' }],
    });
    const response = await post('/v1/messages', JSON.stringify({ messages: [] }));

    expect(await response.text()).toContain('Рустам Урманов');
  });

  it('отклоняет запрос правилом block — наверх не уходит ничего', async () => {
    await start();
    const response = await post(
      '/v1/messages',
      JSON.stringify({ messages: [{ role: 'user', content: 'ключ sk-abc123def' }] }),
    );

    expect(response.status).toBe(403);
    expect(seen).toHaveLength(0);
    const payload = (await response.json()) as { error?: { message?: string } };
    expect(payload.error?.message).toContain('Ключи');
  });

  it('незнакомую форму по умолчанию не пропускает', async () => {
    await start();
    const response = await post('/v2/unknown', JSON.stringify({ text: 'Рустам Урманов' }));

    expect(response.status).toBe(403);
    expect(seen).toHaveLength(0);
  });

  it('незнакомую форму пропускает нетронутой, если это выбрано явно', async () => {
    await start({ passUnknown: true });
    await post('/v2/unknown', JSON.stringify({ text: 'Рустам Урманов' }));

    // Пропущено — значит пропущено КАК ЕСТЬ: маскировать вслепую тело, форму
    // которого не разобрали, значило бы портить чужой запрос наугад.
    expect(seen[0]?.body).toContain('Урманов');
    const entry = readJournal(dir)[0];
    expect(entry?.decision).toBe('passed');
  });

  it('поток событий доходит с восстановленным именем', async () => {
    await start();
    await post(
      '/v1/messages',
      JSON.stringify({ messages: [{ role: 'user', content: 'Рустам Урманов' }] }),
    );

    reply.type = 'text/event-stream';
    reply.body = [
      'event: content_block_delta',
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"привет, [ИМЯ"}}',
      '',
      'event: content_block_delta',
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"_1]!"}}',
      '',
      '',
    ].join('\n');

    const response = await post('/v1/messages', JSON.stringify({ messages: [] }));
    const text = await response.text();

    // Метка была разорвана между кадрами — и всё равно собралась.
    expect(text).toContain('Рустам Урманов');
    expect(text).not.toContain('[ИМЯ');
  });

  it('просит несжатый ответ и не пересылает заголовки соединения', async () => {
    await start();
    await post('/v1/messages', JSON.stringify({ messages: [] }), {
      'accept-encoding': 'gzip, br',
    });

    expect(seen[0]?.headers['accept-encoding']).toBe('identity');
    expect(seen[0]?.headers.connection).not.toBe('keep-alive, foo');
  });

  it('запрос без тела пересылается как есть', async () => {
    await start();
    await fetch(`http://127.0.0.1:${PORT}/v1/models`);
    expect(seen[0]?.path).toBe('/v1/models');
  });

  it('в журнале нет самих значений — только правило, метка и счётчик', async () => {
    await start();
    await post(
      '/v1/messages',
      JSON.stringify({ messages: [{ role: 'user', content: 'Рустам Урманов' }] }),
    );

    const raw = readFileSync(join(dir, 'dlp-journal.jsonl'), 'utf8');
    expect(raw).toContain('[ИМЯ_1]');
    expect(raw).not.toContain('Урманов');
  });

  it('остановка забывает словарь меток', async () => {
    await start();
    await post(
      '/v1/messages',
      JSON.stringify({ messages: [{ role: 'user', content: 'Рустам Урманов' }] }),
    );
    expect(proxy.vaultSize).toBe(1);

    await proxy.stop();
    expect(proxy.vaultSize).toBe(0);
    expect(proxy.status().running).toBe(false);
  });

  it('недоступный адрес наверху — понятный отказ, а не зависание', async () => {
    await start({ upstream: 'http://127.0.0.1:5399' });
    const response = await post('/v1/messages', JSON.stringify({ messages: [] }));
    expect(response.status).toBe(502);
  });
});

describe('joinUpstream', () => {
  it('приклеивает путь запроса к адресу', () => {
    expect(joinUpstream('http://127.0.0.1:1234', '/v1/messages')).toBe(
      'http://127.0.0.1:1234/v1/messages',
    );
  });

  it('не удваивает префикс, который CLI прислал сам', () => {
    // Шлюз настроен как `…/v1`, а CLI просит `/v1/messages` — без этого вышло
    // бы `/v1/v1/messages` и 404 на ровном месте.
    expect(joinUpstream('http://gw.local/v1', '/v1/messages')).toBe('http://gw.local/v1/messages');
  });

  it('добавляет префикс, если его нет', () => {
    expect(joinUpstream('http://gw.local/api', '/chat/completions')).toBe(
      'http://gw.local/api/chat/completions',
    );
  });
});

describe('журнал', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'dlp-journal-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('свежие записи идут первыми', () => {
    for (const path of ['/a', '/b', '/c']) {
      appendJournal(dir, {
        at: '2026-01-01T00:00:00Z',
        path,
        apiKind: 'anthropic',
        decision: 'passed',
        bytes: 1,
        hits: [],
      });
    }
    expect(readJournal(dir).map((entry) => entry.path)).toEqual(['/c', '/b', '/a']);
  });

  it('битая строка пропускается, а не роняет чтение', () => {
    appendJournal(dir, {
      at: '2026-01-01T00:00:00Z',
      path: '/a',
      apiKind: 'anthropic',
      decision: 'passed',
      bytes: 1,
      hits: [],
    });
    writeFileSync(join(dir, 'dlp-journal.jsonl'), '{битое\n{"path":"/b"}\n', { flag: 'a' });
    expect(readJournal(dir)).toHaveLength(2);
  });

  it('очистка оставляет пустую ленту, а не отсутствующий файл', () => {
    appendJournal(dir, {
      at: '2026-01-01T00:00:00Z',
      path: '/a',
      apiKind: 'anthropic',
      decision: 'passed',
      bytes: 1,
      hits: [],
    });
    clearJournal(dir);
    expect(readJournal(dir)).toEqual([]);
  });
});

describe('хранилище правил', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'dlp-rules-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('пишет и читает набор', () => {
    saveRules(dir, [NAMES]);
    expect(readRules(dir).map((item) => item.id)).toEqual(['names']);
  });

  it('битый файл — ОШИБКА, а не «правил нет»', () => {
    // Пустой список после порчи файла означал бы прокси, пропускающий наружу
    // всё и сообщающий при этом, что защита работает.
    writeFileSync(join(dir, 'dlp-rules.json'), '{ не json', 'utf8');
    expect(() => readRules(dir)).toThrow(DlpRulesError);
  });

  it('своё выражение проверяется до записи', () => {
    const broken = rule({ id: 'x', name: 'Кривое', kind: 'regex', pattern: '([a-z' });
    expect(validateRules([broken])).toContain('Кривое');
    expect(() => saveRules(dir, [broken])).toThrow(DlpRulesError);
  });

  it('пустой словарь не сохраняется', () => {
    expect(
      validateRules([rule({ id: 'y', name: 'Пустое', kind: 'terms', terms: ['  '] })]),
    ).toContain('Пустое');
  });
});
