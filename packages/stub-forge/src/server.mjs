/**
 * Сервер заглушки форжа: только loopback, порт 0 (ОС даёт свободный) или порт вызывающего, кроме
 * 5170–5180 (панель, шлюз, DLP). Один сервер отвечает обоими видами по корню пути: `/api/v4` —
 * GitLab, `/api/v3` и облачные `/repos`, `/user` — GitHub REST, `/api/graphql` и `/graphql` —
 * GraphQL GitHub.
 *
 * Пояс P63: путь со звеном слияния или одобрения (`/merge`, `/approve`, `/approvals`, `/reviews`
 * …) и операция GraphQL с таким именем — 404 и строка следа `forbidden: true`, состояние не
 * трогается. Переходник ядра таких путей не знает; след доказывает, что их и не было.
 *
 * След — строка JSON на запрос, дописывается ДО ответа: метод, путь (параметры доступа
 * скрыты), хеш тела, учётка по значению доступа (имя, никогда само значение), код ответа.
 */
import { Buffer } from 'node:buffer';
import { appendFileSync, mkdirSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname } from 'node:path';
import { URL } from 'node:url';
import { createControl } from './control.mjs';
import { handleGithub } from './github.mjs';
import { GRAPHQL_FORBIDDEN, handleGraphql } from './github-graphql.mjs';
import { handleGitlab } from './gitlab.mjs';
import { applyScenarios } from './scenarios.mjs';
import { createState, sha256 } from './state.mjs';

export const RESERVED_PORTS = Object.freeze({ from: 5170, to: 5180 });

const OPTION_KEYS = new Set([
  'port',
  'trace',
  'now',
  'users',
  'projects',
  'scenario',
  'repo',
  'faults',
]);

/** Звено пути слияния или одобрения — у обоих форжей (P63). `merge_requests` — существительное, не оно. */
export const FORBIDDEN_SEGMENT = /^(merge|approve|approvals|unapprove|reviews|auto_merge)$/;

const FAULT_KINDS = new Set(['status', 'garbage', 'stall', 'reset']);

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function send(res, reply) {
  if (res.destroyed || res.writableEnded) return;
  if ('text' in reply) {
    res.writeHead(reply.status, { 'content-type': 'text/plain' });
    res.end(reply.text);
    return;
  }
  res.writeHead(reply.status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(reply.body));
}

/** Значение доступа из заголовков обоих форжей: `PRIVATE-TOKEN`, `Authorization: Bearer|token`. */
function accessOf(req) {
  const own = req.headers['private-token'];
  if (typeof own === 'string' && own) return own;
  const auth = req.headers.authorization;
  const match = typeof auth === 'string' ? auth.match(/^(?:bearer|token)\s+(.+)$/i) : null;
  return match?.[1] ?? null;
}

/** Адрес без значений параметров доступа (`private_token`, `access_token`). */
function redactPath(url) {
  return url.replace(/([?&](?:private_token|access_token|token)=)[^&]*/gi, '$1<present>');
}

function normaliseFault(rule) {
  if (!FAULT_KINDS.has(rule.kind))
    throw new TypeError(`stub-forge: unknown fault kind «${rule.kind}»`);
  const path =
    rule.path === undefined
      ? null
      : rule.path instanceof RegExp
        ? rule.path
        : new RegExp(rule.path);
  return { ...rule, path, times: rule.times ?? Infinity, hits: 0 };
}

function parse(raw) {
  if (!raw) return { body: {}, json: true };
  try {
    const body = JSON.parse(raw);
    return { body: typeof body === 'object' && body !== null ? body : {}, json: true };
  } catch {
    return { body: {}, json: false };
  }
}

export async function startStubForge(options = {}) {
  for (const key of Object.keys(options))
    if (!OPTION_KEYS.has(key)) throw new TypeError(`stub-forge: unknown option «${key}»`);
  const { port = 0, trace } = options;
  if (!Number.isInteger(port) || port < 0 || port > 65535)
    throw new RangeError(`stub-forge: port ${port} is not a TCP port`);
  if (port >= RESERVED_PORTS.from && port <= RESERVED_PORTS.to)
    throw new RangeError(
      `stub-forge: port ${port} is reserved (${RESERVED_PORTS.from}–${RESERVED_PORTS.to})`,
    );
  const state = createState(options);
  applyScenarios(state, options.scenario);
  const control = createControl(state, options.repo);
  const faults = (options.faults ?? []).map(normaliseFault);
  const requests = [];
  const stalled = new Set();
  if (trace) mkdirSync(dirname(trace), { recursive: true });
  let baseUrl = '';

  const record = (entry) => {
    requests.push(entry);
    if (trace) {
      const { body: _body, ...line } = entry;
      appendFileSync(trace, `${JSON.stringify(line)}\n`);
    }
  };

  function controlRoute(method, path, body) {
    if (path === '/__stub/state' && method === 'GET')
      return { status: 200, body: control.snapshot() };
    if (path === '/__stub/act' && method === 'POST')
      return { status: 200, body: control.act(body.as, body) };
    if (path === '/__stub/fault' && method === 'POST') {
      faults.push(normaliseFault(body));
      return { status: 200, body: { faults: faults.length } };
    }
    if (path === '/__stub/fault' && method === 'DELETE') {
      faults.length = 0;
      return { status: 200, body: { faults: 0 } };
    }
    if (path === '/__stub/sync-pushes' && method === 'POST')
      return { status: 200, body: control.syncPushes(body.as, body.project) };
    return { status: 404, body: { message: 'no such control path' } };
  }

  /** Маршрут по корню пути; `undefined` — пути нет в подмножестве. */
  function route(ctx, path, segments) {
    if (path === '/graphql' || path === '/api/graphql')
      return ctx.method === 'POST' ? handleGraphql(ctx) : undefined;
    if (segments[0] === 'api' && segments[1] === 'v4') return handleGitlab(ctx, segments.slice(2));
    if (segments[0] === 'api' && segments[1] === 'v3') return handleGithub(ctx, segments.slice(2));
    return handleGithub(ctx, segments);
  }

  async function handle(req, res) {
    const raw = await readBody(req);
    const url = new URL(req.url ?? '/', 'http://stub');
    const method = req.method ?? 'GET';
    const { body, json } = parse(raw);
    const entry = {
      at: state.now(),
      method,
      path: redactPath(req.url ?? '/'),
      bodyHash: raw ? sha256(raw) : null,
      tokenId: null,
      status: 0,
      body: json ? body : raw,
    };
    if (url.pathname.startsWith('/__stub/')) {
      let reply;
      try {
        reply = controlRoute(method, url.pathname, body);
      } catch (error) {
        reply = {
          status: 400,
          body: { message: error instanceof Error ? error.message : String(error) },
        };
      }
      record({ ...entry, control: true, status: reply.status });
      send(res, reply);
      return;
    }
    const access = accessOf(req);
    const actor = state.userByToken(access);
    entry.tokenId = actor ? actor.username : access ? 'unknown' : null;
    const segments = url.pathname
      .split('/')
      .filter(Boolean)
      .map((s) => decodeURIComponent(s));
    const isGraphql = url.pathname.endsWith('/graphql');
    const forbidden =
      segments.some((s) => FORBIDDEN_SEGMENT.test(s)) ||
      (isGraphql && typeof body.query === 'string' && GRAPHQL_FORBIDDEN.test(body.query));
    if (forbidden) {
      record({ ...entry, forbidden: true, status: 404 });
      send(res, { status: 404, body: { message: '404 Not Found' } });
      return;
    }
    const fault = faults.find(
      (f) =>
        f.hits < f.times &&
        (!f.method || f.method === method) &&
        (!f.path || f.path.test(url.pathname)),
    );
    if (fault) {
      fault.hits += 1;
      record({ ...entry, fault: fault.kind, status: fault.kind === 'status' ? fault.status : 0 });
      if (fault.kind === 'reset') req.socket.destroy();
      else if (fault.kind === 'garbage')
        send(res, { status: 200, text: '<html>gateway says hello' });
      else if (fault.kind === 'status')
        send(res, { status: fault.status, body: { message: `stub fault ${fault.status}` } });
      else stalled.add(res);
      return;
    }
    if (!actor) {
      record({ ...entry, status: 401 });
      send(res, { status: 401, body: { message: '401 Unauthorized' } });
      return;
    }
    const ctx = {
      state,
      method,
      query: url.searchParams,
      body,
      actor,
      baseUrl,
      headOf: control.headOf,
    };
    let reply;
    try {
      reply = route(ctx, url.pathname, segments) ?? {
        status: 404,
        body: { message: '404 Not Found' },
      };
    } catch (error) {
      reply = {
        status: 400,
        body: { message: error instanceof Error ? error.message : String(error) },
      };
    }
    record({ ...entry, status: reply.status });
    send(res, reply);
  }

  const server = createServer((req, res) => {
    res.on('close', () => stalled.delete(res));
    handle(req, res).catch((error) => send(res, { status: 500, body: { message: String(error) } }));
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      const address = server.address();
      baseUrl = `http://127.0.0.1:${address.port}`;
      resolve({
        url: baseUrl,
        port: address.port,
        requests,
        tokens: Object.fromEntries(state.users.map((u) => [u.username, u.token])),
        act: control.act,
        syncPushes: control.syncPushes,
        state: control.snapshot,
        fault(rule) {
          faults.push(normaliseFault(rule));
        },
        clearFaults() {
          faults.length = 0;
        },
        stop() {
          for (const res of stalled) res.destroy();
          stalled.clear();
          server.closeAllConnections?.();
          return new Promise((done) => server.close(() => done()));
        },
      });
    });
  });
}

/** Адрес, на котором никто не слушает: отказ соединения для пробы сбоя (`refused`). */
export function closedPortUrl() {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(`http://127.0.0.1:${port}`));
    });
  });
}
