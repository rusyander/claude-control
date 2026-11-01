import { readFileSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { DlpRule } from '@agentdeck/contracts';
import { hopHostProcRowSchema, type HopRegisterSpec } from '@agentdeck/contracts/core/hops';
import { rulesHashOf } from '@agentdeck/dlp/rules-hash';
import { HopHostError, hopStatus, registerTag } from '../routes/hops/hops.ts';
import { anthropicBody, ask, hopStand, type HopStand } from './__fixtures__/hop-stand.ts';
import { startHopHost, type RunningHopHost } from './host.ts';

/**
 * Протокол управления по схеме контракта (`@agentdeck/contracts/core/hops`) через настоящий сокет
 * управления: старый вызов принят со значениями по умолчанию, битое сообщение названо, драйвер —
 * явным полем, правила маски — данными регистрации, язык отказов — сеанса, статус и строка
 * `procs.json` — той формы, что в контракте.
 */

let stand: HopStand | undefined;
const extra: { close(): Promise<void> | void }[] = [];
afterEach(async () => {
  for (const item of extra.splice(0)) await Promise.resolve(item.close()).catch(() => undefined);
  await stand?.close().catch(() => undefined);
  stand = undefined;
});

function baseSpec(s: HopStand, over: Partial<HopRegisterSpec> = {}): HopRegisterSpec {
  return {
    tag: 'task-c.s1',
    sessionId: 'session-c',
    routeId: 'route-stub',
    upstream: s.stub.baseUrl,
    from: 'anthropic-messages',
    to: 'anthropic-messages',
    keyRef: null,
    dlp: { required: false, rulesHash: null },
    features: [],
    ...over,
  };
}

async function rawControl(
  s: HopStand,
  message: unknown,
): Promise<{ status: number; json: Record<string, unknown> }> {
  const response = await fetch(`${s.handle.url}/hops`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${s.handle.token}` },
    body: JSON.stringify(message),
  });
  return { status: response.status, json: (await response.json()) as Record<string, unknown> };
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

async function listen(server: Server, port = 0): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve());
  });
  return (server.address() as AddressInfo).port;
}

describe('протокол управления по схеме контракта', () => {
  it('прежний вызов без драйвера, цены и правил принят: значения по умолчанию проставлены', async () => {
    stand = await hopStand({ script: ['ok'] });
    await registerTag(stand.handle, baseSpec(stand));
    expect(stand.host.ctx.tags.byTag('task-c.s1')?.spec).toMatchObject({
      driver: null,
      price: null,
      dlp: { required: false, rulesHash: null, rules: null },
    });
  });

  it('файл меток прежнего хоста: метка жива после перезапуска, значения по умолчанию проставлены', async () => {
    stand = await hopStand({ script: ['ok'] });
    const placeholderHash = 'a'.repeat(64);
    await stand.host.close();
    // Строка в форме до полей драйвера, цены и правил — так её писал хост зоны H.
    const legacy = { ...baseSpec(stand), tag: 'task-old.s1' };
    writeFileSync(
      join(stand.home, 'hops', 'tags.json'),
      JSON.stringify({ v: 1, tags: [{ spec: legacy, placeholderHash, registeredAt: 1 }] }),
    );
    const again = await startHopHost({ home: stand.home, panelAppData: stand.appData });
    extra.unshift({ close: () => again.close() });
    expect(again.ctx.tags.byTag('task-old.s1')?.spec).toMatchObject({
      tag: 'task-old.s1',
      driver: null,
      price: null,
      dlp: { rules: null },
    });
  });

  it('битое сообщение → bad_request с названным полем, метка не заведена', async () => {
    stand = await hopStand({ script: ['ok'] });
    const { tag: _drop, ...noTag } = baseSpec(stand);
    const missing = await rawControl(stand, { op: 'register', spec: noTag });
    expect(missing.status).toBe(400);
    expect(missing.json).toMatchObject({ op: 'register', ok: false, code: 'bad_request' });
    expect(String(missing.json.detail)).toContain('spec.tag');

    const foreign = await rawControl(stand, {
      op: 'register',
      spec: { ...baseSpec(stand), surprise: true },
    });
    expect(foreign.json).toMatchObject({ ok: false, code: 'bad_request' });

    const notHttp = await rawControl(stand, {
      op: 'register',
      spec: baseSpec(stand, { upstream: 'file:///etc/passwd' }),
    });
    expect(notHttp.json).toMatchObject({ ok: false, code: 'bad_request' });
    expect(String(notHttp.json.detail)).toContain('upstream');

    const unknownOp = await rawControl(stand, { op: 'reboot' });
    expect(unknownOp.json).toMatchObject({ op: 'status', ok: false, code: 'bad_request' });
    expect(stand.host.ctx.tags.tags()).toEqual([]);
  });

  it('ответ не по схеме контракта → клиент ядра бросает bad_reply, не верит форме', async () => {
    stand = await hopStand({ script: ['ok'] });
    const liar = createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ op: 'status', ok: true }));
    });
    const port = await listen(liar);
    extra.push({ close: () => closeServer(liar) });
    const error = await hopStatus({ ...stand.handle, url: `http://127.0.0.1:${port}` }).catch(
      (thrown: unknown) => thrown,
    );
    expect(error).toBeInstanceOf(HopHostError);
    expect((error as HopHostError).code).toBe('bad_reply');
  });
});

describe('драйвер шлюза — явное поле регистрации', () => {
  const platform451 = {
    status: 451,
    body: { error: { message: 'blocked', violations: [{ rule_type: 'pii_scanner' }] } },
  };

  it('явный driver без возможности driver:<id> → шлюз с драйвером платформы (отказ 451 назван)', async () => {
    stand = await hopStand({
      script: ['never'],
      reply: (request) => (request.path.endsWith('/completions') ? platform451 : undefined),
    });
    const reply = await registerTag(
      stand.handle,
      baseSpec(stand, { to: 'openai-chat', driver: 'enterprise-platform' }),
    );
    const answer = await ask(reply.port, reply.placeholder, 'anthropic', anthropicBody('x'));
    const error = (answer.json as { error?: { code?: string; message?: string } }).error;
    expect(error?.code).toBe('content_policy_violation');
    expect(error?.message).toContain('pii_scanner');
  });

  it('драйвер на одном диалекте без возможностей → порт шлюза, не DLP-звена', async () => {
    stand = await hopStand({ script: ['ok'] });
    const reply = await registerTag(stand.handle, baseSpec(stand, { driver: 'openai-compat' }));
    expect(reply.port).toBe(stand.host.ports.gateway);
    const plain = await registerTag(stand.handle, baseSpec(stand, { tag: 'task-c.s2' }));
    expect(plain.port).toBe(stand.host.ports.dlp);
  });

  it('неизвестный драйвер или расхождение с driver:<id> → отказ регистрации, заглушки нет', async () => {
    stand = await hopStand({ script: ['ok'] });
    const unknown = await registerTag(stand.handle, baseSpec(stand, { driver: 'no-such' })).catch(
      (thrown: unknown) => thrown,
    );
    expect((unknown as HopHostError).code).toBe('unknown_driver');
    const conflict = await registerTag(
      stand.handle,
      baseSpec(stand, { driver: 'openai-compat', features: ['driver:enterprise-platform'] }),
    ).catch((thrown: unknown) => thrown);
    expect((conflict as HopHostError).code).toBe('driver_conflict');
    expect(stand.host.ctx.tags.tags()).toEqual([]);
  });
});

describe('правила маски — данными регистрации', () => {
  const rules: DlpRule[] = [
    {
      id: 'names',
      name: 'Сотрудники',
      enabled: true,
      kind: 'terms',
      terms: ['Иванов'],
      pattern: '',
      action: 'mask',
      label: 'ФИО',
    },
  ];

  it('присланные правила применяет звено, а не правила каталога панели хоста', async () => {
    stand = await hopStand({ script: ['ok'] });
    const reply = await registerTag(
      stand.handle,
      baseSpec(stand, { dlp: { required: true, rulesHash: rulesHashOf(rules), rules } }),
    );
    const answer = await ask(reply.port, reply.placeholder, 'anthropic', anthropicBody('Иванов'));
    expect(answer.status).toBe(200);
    const sent = stand.seen.at(-1)?.raw ?? '';
    expect(sent).not.toContain('Иванов');
    expect(sent).toContain('ФИО');
  });

  it('хэш не совпал с присланными правилами → dlp_rules_mismatch', async () => {
    stand = await hopStand({ script: ['ok'] });
    const error = await registerTag(
      stand.handle,
      baseSpec(stand, { dlp: { required: true, rulesHash: 'f'.repeat(64), rules } }),
    ).catch((thrown: unknown) => thrown);
    expect((error as HopHostError).code).toBe('dlp_rules_mismatch');
  });
});

describe('язык отказов — сеанса', () => {
  it('сеанс назвал en → отказ по-английски; не назвал → язык хоста (ru)', async () => {
    stand = await hopStand({ script: ['ok'] });
    const en = await registerTag(stand.handle, baseSpec(stand, { language: 'en' }));
    const ru = await registerTag(stand.handle, baseSpec(stand, { tag: 'task-c.s2' }));
    stand.host.ctx.spend.markExhausted('route-stub', Date.now());
    const messageOf = async (reply: { port: number; placeholder: string }): Promise<string> => {
      const answer = await ask(reply.port, reply.placeholder, 'anthropic', anthropicBody('x'));
      expect(answer.status).toBe(402);
      return (answer.json as { error?: { message?: string } }).error?.message ?? '';
    };
    const english = await messageOf(en);
    expect(english).toContain('exhausted');
    expect(english).not.toMatch(/[А-Яа-я]/);
    expect(await messageOf(ru)).toMatch(/исчерпал/);
  });
});

describe('статус и строка procs.json — форма контракта', () => {
  it('строка хоста в procs.json: port — управление, рядом порты звеньев', async () => {
    stand = await hopStand({ script: ['ok'] });
    const procs = JSON.parse(readFileSync(join(stand.home, 'procs.json'), 'utf8')) as {
      servers: unknown[];
    };
    const row = procs.servers
      .map((item) => hopHostProcRowSchema.safeParse(item))
      .find((parsed) => parsed.success)?.data;
    expect(row).toMatchObject({
      kind: 'hop-host',
      port: stand.host.ports.control,
      dlpPort: stand.host.ports.dlp,
      gatewayPort: stand.host.ports.gateway,
    });
  });

  it('статус называет каталог данных панели и подстановку занятого порта (P46)', async () => {
    stand = await hopStand({ script: ['ok'] });
    expect((await hopStatus(stand.handle)).panelAppData).toBe(stand.appData);
    const { dlp } = stand.host.ports;
    await stand.host.close();
    const squatter = createServer(() => undefined);
    await listen(squatter, dlp);
    extra.push({ close: () => closeServer(squatter) });
    const again: RunningHopHost = await startHopHost({
      home: stand.home,
      panelAppData: stand.appData,
    });
    extra.unshift({ close: () => again.close() });
    const status = await hopStatus({
      ...stand.handle,
      url: `http://127.0.0.1:${again.ports.control}`,
    });
    expect(status.substitutions).toEqual([
      expect.objectContaining({ listener: 'dlp', recorded: dlp, actual: again.ports.dlp }),
    ]);
  });
});
