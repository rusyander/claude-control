import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { registerAccessGate } from '../access-gate/access-gate.ts';
import { allowedOrigins } from '../origin-guard/origin-guard.ts';
import {
  BRIDGE_TOKEN_HEADER,
  createBridgeTokenLedger,
  isAgentActionsPath,
  type BridgeTokenLedger,
} from './bridge-tokens.ts';

/**
 * Токен моста сессии ядра «ask» (этап 10, F2): живёт ровно ход агента, пускает только на действия
 * агента. Проверка идёт тем же хуком гейта, что стоит у человека, на своём Fastify: 200 значит
 * «гейт пропустил», 401 — «отказ до маршрута».
 */
describe('журнал токенов моста', () => {
  it('выдан — владелец известен; снят — неизвестен; итоги хода отдаются при снятии', () => {
    const ledger = createBridgeTokenLedger();
    const token = ledger.mint('conv-1');
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(ledger.ownerOf(token)).toBe('conv-1');
    ledger.note(token, 'where_am_i');
    ledger.note(token, 'save_rule (failed)');
    expect(ledger.revoke(token)).toEqual(['where_am_i', 'save_rule (failed)']);
    expect(ledger.ownerOf(token)).toBeUndefined();
    expect(ledger.revoke(token)).toEqual([]);
    expect(ledger.size()).toBe(0);
  });

  it('токен не переживает свой срок, даже если ход его не снял', () => {
    let at = 1_000;
    const ledger = createBridgeTokenLedger({ ttlMs: 500, now: () => at });
    const token = ledger.mint('conv-1');
    at += 499;
    expect(ledger.ownerOf(token)).toBe('conv-1');
    at += 1;
    expect(ledger.ownerOf(token)).toBeUndefined();
    expect(ledger.size()).toBe(0);
  });

  it('каждый ход — свой токен; чужой токен владельца не меняет', () => {
    const ledger = createBridgeTokenLedger();
    const a = ledger.mint('conv-a');
    const b = ledger.mint('conv-b');
    expect(a).not.toBe(b);
    expect(ledger.ownerOf(a)).toBe('conv-a');
    expect(ledger.ownerOf(b)).toBe('conv-b');
    expect(ledger.ownerOf(a.slice(0, -1) + (a.endsWith('A') ? 'B' : 'A'))).toBeUndefined();
  });

  it('путь действий агента — только сам список и действия под ним', () => {
    expect(isAgentActionsPath('/api/agent/actions')).toBe(true);
    expect(isAgentActionsPath('/api/agent/actions/where_am_i?x=1')).toBe(true);
    expect(isAgentActionsPath('/api/agent/actionsX')).toBe(false);
    expect(isAgentActionsPath('/api/agent/pending/1')).toBe(false);
    expect(isAgentActionsPath('/api/agent/conversations')).toBe(false);
  });
});

describe('гейт доступа и токен моста', () => {
  const TOKEN = 'panel-remote-token-value';
  let app: FastifyInstance;
  let ledger: BridgeTokenLedger;
  let remote: boolean;

  beforeEach(async () => {
    ledger = createBridgeTokenLedger();
    remote = false;
    app = Fastify();
    registerAccessGate(app, {
      allowedOrigins: allowedOrigins(8888),
      requiresToken: () => remote,
      expectedToken: () => TOKEN,
      bridges: ledger,
    });
    app.get('/api/agent/actions', () => ({ list: true }));
    app.post('/api/agent/actions/:name', () => ({ ran: true }));
    app.post('/api/agent/pending/:id', () => ({ decided: true }));
    app.get('/api/agent/conversations', () => ({ list: true }));
    app.get('/api/system', () => ({ ok: true }));
    await app.ready();
  });
  afterEach(async () => app.close());

  const withBridge = (token: string, url: string, method: 'GET' | 'POST' = 'GET') =>
    app.inject({
      method,
      url,
      headers: { [BRIDGE_TOKEN_HEADER]: token },
      ...(method === 'POST' ? { payload: {} } : {}),
    });

  it('живой токен проходит на действия агента — и при включённом удалённом доступе', async () => {
    const token = ledger.mint('conv-1');
    expect((await withBridge(token, '/api/agent/actions')).statusCode).toBe(200);
    remote = true;
    expect((await withBridge(token, '/api/agent/actions/where_am_i', 'POST')).statusCode).toBe(200);
  });

  it('живой токен не открывает ничего кроме действий: решение карточки, разговоры, система', async () => {
    const token = ledger.mint('conv-1');
    expect((await withBridge(token, '/api/agent/pending/1', 'POST')).statusCode).toBe(401);
    expect((await withBridge(token, '/api/agent/conversations')).statusCode).toBe(401);
    expect((await withBridge(token, '/api/system')).statusCode).toBe(401);
    // Точки в пути роутер не сворачивает: такой адрес не доходит до разговоров.
    const dotted = await withBridge(token, '/api/agent/actions/../conversations');
    expect(dotted.payload).not.toContain('"list":true');
  });

  it('снятый, просроченный и выдуманный токен — 401 даже без удалённого доступа', async () => {
    const token = ledger.mint('conv-1');
    ledger.revoke(token);
    expect((await withBridge(token, '/api/agent/actions')).statusCode).toBe(401);
    expect((await withBridge('x'.repeat(43), '/api/agent/actions')).statusCode).toBe(401);
    // Токен моста не заменяется токеном панели в том же заголовке.
    expect((await withBridge(TOKEN, '/api/agent/actions')).statusCode).toBe(401);
  });

  it('без журнала токенов (гейт не подключён к ходам) заголовок моста не пускает никуда', async () => {
    await app.close();
    app = Fastify();
    registerAccessGate(app, {
      allowedOrigins: allowedOrigins(8888),
      requiresToken: () => false,
      expectedToken: () => '',
    });
    app.get('/api/agent/actions', () => ({ list: true }));
    await app.ready();
    expect((await withBridge(ledger.mint('c'), '/api/agent/actions')).statusCode).toBe(401);
  });
});
