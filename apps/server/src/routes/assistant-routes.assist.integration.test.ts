import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { registerAssistantRoutes } from './assistant-routes.ts';

/**
 * `POST /api/assist` целиком через настоящий маршрут (U6, 28.09): тело
 * проверяется схемой, история едет в запросе, запуск — лёгкое окно, секреты
 * формы — маской до модели и обратно секретом.
 *
 * Настоящий `claude` тесту недоступен вовсе: PATH процесса — только каталог
 * фальшивого CLI и системный каталог (для `cmd.exe`). Фальшивый CLI пишет argv и
 * stdin и отвечает заданным текстом.
 */
const isWindows = process.platform === 'win32';

const FAKE = `
import { readFileSync, writeFileSync } from 'node:fs';
const argv = process.argv.slice(2);
const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const near = (name) => new URL('./' + name, import.meta.url);
writeFileSync(near('dump.json'), JSON.stringify({ argv, stdin: Buffer.concat(chunks).toString('utf8') }));
process.stdout.write(JSON.stringify({ result: readFileSync(near('answer.json'), 'utf8'), session_id: 'sess-route' }));
`;

let app: FastifyInstance | undefined;
let dir: string;
let savedPath: string | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cc-assist-route-'));
  const script = join(dir, 'fake-claude.mjs');
  writeFileSync(script, FAKE, 'utf8');
  if (isWindows) {
    writeFileSync(join(dir, 'claude.cmd'), `@echo off\r\n"${process.execPath}" "${script}" %*\r\n`);
  } else {
    writeFileSync(join(dir, 'claude'), `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`, {
      mode: 0o755,
    });
  }
  savedPath = process.env.PATH;
  const system = isWindows ? join(process.env.SystemRoot ?? 'C:\\Windows', 'System32') : '/bin';
  process.env.PATH = [dir, system].join(isWindows ? ';' : ':');
  app = Fastify();
  registerAssistantRoutes(app, { store: { getSettings: () => ({ provider: 'claude' }) } } as never);
});

afterEach(async () => {
  await app?.close();
  app = undefined;
  process.env.PATH = savedPath;
  rmSync(dir, { recursive: true, force: true });
});

const answer = (value: unknown): void =>
  writeFileSync(join(dir, 'answer.json'), JSON.stringify(value), 'utf8');
const dump = (): { argv: string[]; stdin: string } =>
  JSON.parse(readFileSync(join(dir, 'dump.json'), 'utf8')) as { argv: string[]; stdin: string };

const post = (payload: unknown) =>
  app!.inject({ method: 'POST', url: '/api/assist', payload: payload as object });

describe('POST /api/assist', () => {
  it.each([
    ['нет просьбы', { kind: 'rule', fields: {}, schema: {} }],
    ['поля — не объект', { kind: 'rule', message: 'x', fields: 'title=x', schema: {} }],
    ['история — не список реплик', { kind: 'rule', message: 'x', fields: {}, history: 'hi' }],
    [
      'реплика истории чужой роли',
      { kind: 'rule', message: 'x', fields: {}, history: [{ role: 'system', text: 'x' }] },
    ],
  ])('кривое тело (%s) → 400 с кодом, CLI не запускается', async (_name, payload) => {
    answer({ reply: 'never', fields: {} });
    const response = await post(payload);
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      error: 'invalid_body',
      messageCode: 'assistant-request-invalid',
    });
    expect(() => dump()).toThrow();
  });

  it('история и маска — через маршрут; ответ без сессии, секрет вернулся на место', async () => {
    answer({
      reply: 'Добавил QA_MODE.',
      fields: { envText: 'QA_API_TOKEN=••••••\nQA_MODE=1' },
    });
    const response = await post({
      kind: 'MCP server',
      message: 'добавь QA_MODE=1',
      fields: { name: 'qa', envText: 'QA_API_TOKEN=qa-route-secret-1' },
      schema: { envText: 'Env lines. Value: a string.' },
      history: [
        { role: 'user', text: 'назови сервер qa' },
        { role: 'assistant', text: 'Назвал.' },
      ],
      // Старая вкладка ещё шлёт id сессии — он молча игнорируется.
      sessionId: 'd3b07384-d9a0-4c9b-8a4e-0f1e2d3c4b5a',
    });
    expect(response.statusCode).toBe(200);
    const body = response.json() as Record<string, unknown>;
    expect(body.fields).toEqual({ envText: 'QA_API_TOKEN=qa-route-secret-1\nQA_MODE=1' });
    expect(body).not.toHaveProperty('sessionId');

    const seen = dump();
    expect(seen.argv).toContain('--no-session-persistence');
    expect(seen.argv).not.toContain('--resume');
    expect(seen.stdin).not.toContain('qa-route-secret-1');
    expect(seen.stdin).toContain('Human: назови сервер qa');
    expect(seen.stdin).toContain("The user's current request: добавь QA_MODE=1");
  });

  // Ревью F3 (28.09): значения в кавычках, с пробелом, `#` и `&` детектор резал
  // или пропускал — и все они настоящие: форма хранит хвост строки целиком, а
  // `formatArgs` берёт в кавычки любой аргумент с пробелом.
  it('секреты в кавычках, с пробелом, # и & — маской; нетронутые строки вернулись секретами', async () => {
    const envText = [
      'DB_PASSWORD="hunter two 2"',
      'API_KEY=abc#def123XYZ',
      "SECRET_TOKEN='qwerty12'",
      'AUTH_TOKEN=tok&en 42',
      'QA_MODE=0',
    ].join('\n');
    const headersText = 'X-Api-Key=my hdr v4lue x';
    const args = '--api-key "hunter two2" "--db-password=pa ss 9" --verbose';
    answer({
      reply: 'Поменял QA_MODE.',
      fields: {
        envText:
          'DB_PASSWORD=••••••\nAPI_KEY=••••••\nSECRET_TOKEN=••••••\nAUTH_TOKEN=••••••\nQA_MODE=1',
        headersText: 'X-Api-Key=••••••',
        args: '--api-key •••••• --db-password=•••••• --verbose',
      },
    });
    const response = await post({
      kind: 'MCP server',
      // Без имени рядом hex — всё равно маской: хэши видит только общий раннер (F6).
      message: 'поставь QA_MODE=1, ключ a94a8fe5ccb19ba61c4c0873d391e987982fbbd3',
      fields: { name: 'qa', envText, headersText, args },
      schema: { envText: 'Env lines.', headersText: 'Header lines.', args: 'Arguments.' },
    });
    const { stdin } = dump();
    for (const leak of [
      'hunter two 2',
      'hunter',
      'def123XYZ',
      'qwerty12',
      'tok&en',
      'en 42',
      'hdr v4lue',
      'pa ss 9',
      'a94a8fe5ccb19ba61c4c0873d391e987982fbbd3',
    ]) {
      expect(stdin, leak).not.toContain(leak);
    }

    expect(response.statusCode).toBe(200);
    const body = response.json() as { fields: Record<string, unknown>; kept?: string[] };
    expect(body.fields).toEqual({
      envText: envText.replace('QA_MODE=0', 'QA_MODE=1'),
      headersText,
      args,
    });
    expect(body.kept).toBeUndefined();
  });
});
