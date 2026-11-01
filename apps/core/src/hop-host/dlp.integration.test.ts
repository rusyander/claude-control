import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { setStoredKey } from '@agentdeck/keys/provider-keys';
import { rulesPath } from '@agentdeck/dlp/rules-file';
import { applyHopEnv } from '../routes/hops/hops.ts';
import {
  anthropicBody,
  ask,
  filesContaining,
  hopStand,
  tempDir,
  type HopStand,
} from './__fixtures__/hop-stand.ts';

const FAKE_CLI = fileURLToPath(new URL('./__fixtures__/fake-cli.ts', import.meta.url));

/** Значения собраны из кусков: в репозитории нет строки, похожей на ключ или адрес. */
const j = (...parts: string[]): string => parts.join('');
const EMAIL = j('ivan.petrov', '@', 'corp-example', '.ru');

let stand: HopStand | undefined;
afterEach(async () => {
  await stand?.close().catch(() => undefined);
  stand = undefined;
});

function errorCode(json: unknown): string | undefined {
  const error = (json as { error?: { code?: string; type?: string } } | undefined)?.error;
  return error?.code;
}

describe('DLP-звено (P124) — непрозрачное тело не уходит', () => {
  it('P124 политика требует маску, тело не JSON → отказ dlp_opaque, до контура ничего', async () => {
    stand = await hopStand({ script: ['never'] });
    const reply = await stand.register({ dlp: { required: true, rulesHash: null } });
    expect(reply.port).toBe(stand.host.ports.dlp);
    const answer = await ask(reply.port, reply.placeholder, 'anthropic', `{"model": oops ${EMAIL}`);
    expect(answer.status).toBe(400);
    expect(errorCode(answer.json)).toBe('dlp_opaque');
    expect(stand.seen).toHaveLength(0);
  });

  it('P124 правила маски не читаются → отказ dlp_opaque, до контура ничего', async () => {
    stand = await hopStand({
      script: ['never'],
      prepare: (appData) => writeFileSync(rulesPath(appData), '{ broken'),
    });
    const reply = await stand.register({ dlp: { required: true, rulesHash: null } });
    const answer = await ask(reply.port, reply.placeholder, 'anthropic', anthropicBody('hi'));
    expect(answer.status).toBe(400);
    expect(errorCode(answer.json)).toBe('dlp_opaque');
    expect(stand.seen).toHaveLength(0);
  });

  it('P124 разобранное тело уходит с маской: адреса почты наверху нет, ответ клиенту дошёл', async () => {
    stand = await hopStand({ script: ['masked ok'] });
    const reply = await stand.register({ dlp: { required: true, rulesHash: null } });
    const answer = await ask(
      reply.port,
      reply.placeholder,
      'anthropic',
      anthropicBody(`write to ${EMAIL}`),
    );
    expect(answer.status).toBe(200);
    expect(answer.text).toContain('masked ok');
    expect(stand.seen).toHaveLength(1);
    expect(stand.seen[0]?.raw).not.toContain(EMAIL);
  });

  it('P124 звено лежит → запрос CLI упирается в закрытый порт, до контура ничего', async () => {
    stand = await hopStand({ script: ['never'] });
    const reply = await stand.register({ dlp: { required: true, rulesHash: null } });
    const env = applyHopEnv({ PATH: 'x' }, { from: 'anthropic-messages', keyRef: null }, reply);
    // Адреса контура у сеанса нет вовсе: «мимо звена» идти некуда.
    expect(Object.values(env).join(' ')).not.toContain(stand.stub.baseUrl);
    await stand.host.close();
    const failed = await ask(reply.port, reply.placeholder, 'anthropic', anthropicBody('hi')).then(
      () => false,
      () => true,
    );
    expect(failed).toBe(true);
    expect(stand.seen).toHaveLength(0);
  });

  it('P124 незнакомая заглушка → 401, до контура ничего', async () => {
    stand = await hopStand({ script: ['never'] });
    await stand.register();
    const answer = await ask(
      stand.host.ports.dlp,
      'adk-hop-forged',
      'anthropic',
      anthropicBody('hi'),
    );
    expect(answer.status).toBe(401);
    expect(stand.seen).toHaveLength(0);
  });
});

describe('ключ маршрута (P112) — только в заголовке наверх', () => {
  it('P112 посаженный ключ: наверху в x-api-key, в окружении и argv CLI — заглушка, в доме ядра — нигде', async () => {
    const planted = j('sk-ant-', 'planted', '-0123456789abcdef');
    stand = await hopStand({
      script: ['from the contour'],
      prepare: (appData) => setStoredKey(appData, 'stub-key', planted),
    });
    const reply = await stand.register({ keyRef: { kind: 'panel-store', name: 'stub-key' } });
    // Окружение ядра несёт ключ под всеми именами, которые CLI читает: звено их вычищает.
    const parent = {
      ...process.env,
      ANTHROPIC_API_KEY: planted,
      ANTHROPIC_AUTH_TOKEN: planted,
      OPENAI_API_KEY: planted,
    };
    const env = applyHopEnv(parent, { from: 'anthropic-messages', keyRef: null }, reply);
    expect(env.ANTHROPIC_API_KEY).toBe(reply.placeholder);
    expect(env.ANTHROPIC_BASE_URL).toBe(`http://127.0.0.1:${reply.port}`);

    const dump = join(tempDir('hop-cli-'), 'dump.json');
    const child = spawn(
      process.execPath,
      ['--experimental-strip-types', '--no-warnings', FAKE_CLI, dump, 'hello'],
      { env, stdio: ['ignore', 'pipe', 'inherit'] },
    );
    let out = '';
    child.stdout.on('data', (chunk: Buffer) => (out += chunk.toString('utf8')));
    await once(child, 'exit');
    expect(out).toMatch(/^STATUS 200 /);
    expect(out).toContain('from the contour');

    const dumped = readFileSync(dump, 'utf8');
    expect(dumped).not.toContain(planted);
    expect(dumped).toContain(reply.placeholder);
    // Звено подставило настоящий ключ — наверху он есть, и только он.
    expect(stand.seen).toHaveLength(1);
    expect(stand.seen[0]?.headers['x-api-key']).toBe(planted);

    stand.host.ctx.spend.flush();
    expect(filesContaining(stand.home, planted)).toEqual([]);
    // Заглушка хранится только хэшем: файл меток и след её не содержат.
    expect(filesContaining(stand.home, reply.placeholder)).toEqual([]);
  });

  it('P112 ключ по ссылке env: имя ссылки вычищено из окружения сеанса', () => {
    const env = applyHopEnv(
      { VENDOR_KEY: 'secret-value', PATH: 'x' },
      { from: 'openai-chat', keyRef: { kind: 'env', name: 'VENDOR_KEY' } },
      { port: 40001, placeholder: 'adk-hop-x' },
    );
    expect(env.VENDOR_KEY).toBeUndefined();
    expect(env.OPENAI_API_KEY).toBe('adk-hop-x');
    expect(env.OPENAI_BASE_URL).toBe('http://127.0.0.1:40001/v1');
  });
});
