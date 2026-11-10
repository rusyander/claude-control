/**
 * Сервер заглушки трекера: только loopback, порт 0 (ОС даёт свободный) или порт вызывающего, кроме
 * 5170–5180 (панель, шлюз, DLP). Один сайт — один диалект (`deployment`):
 *
 * - `cloud`: Basic `почта:токен`, Jira на `/rest/api/3` (и `/rest/api/2`, как у облака), поиск
 *   `/search/jql` и классический `/search`; Bearer — 401;
 * - `server` (Server/DC): `Bearer токен`, только `/rest/api/2`, `/search/jql` нет; Basic — 401,
 *   `/rest/api/3` — 404.
 *
 * Перепутанный диалект авторизации получает отказ — ровно то, на чём клиент ломался бы у
 * настоящего трекера. След — строка JSON на запрос, дописывается ДО ответа: метод, путь, JQL как
 * его понял сервер, схема авторизации и учётка по значению доступа (имя, никогда само значение),
 * код ответа, хеш тела.
 */
import { Buffer } from 'node:buffer';
import { appendFileSync, mkdirSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname } from 'node:path';
import { URL } from 'node:url';
import { handleJira } from './jira.mjs';
import { createState, sha256 } from './state.mjs';

export const RESERVED_PORTS = Object.freeze({ from: 5170, to: 5180 });

const OPTION_KEYS = new Set([
  'port',
  'trace',
  'now',
  'deployment',
  'users',
  'projects',
  'issues',
  'faults',
]);
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
    res.writeHead(reply.status, reply.text ? { 'content-type': 'text/plain' } : {});
    res.end(reply.text);
    return;
  }
  res.writeHead(reply.status, { 'content-type': 'application/json', ...(reply.headers ?? {}) });
  res.end(JSON.stringify(reply.body));
}

/** Схема и учётка по заголовку `Authorization`; значение доступа дальше этой функции не идёт. */
function authOf(req, state) {
  const header = req.headers.authorization;
  if (typeof header !== 'string' || !header) return { scheme: null, user: null, presented: false };
  const basic = /^basic\s+(.+)$/i.exec(header);
  if (basic) {
    const pair = Buffer.from(basic[1], 'base64').toString('utf8');
    const cut = pair.indexOf(':');
    const email = cut < 0 ? '' : pair.slice(0, cut);
    const token = cut < 0 ? pair : pair.slice(cut + 1);
    const user = state.users.find((u) => u.email === email && u.token === token) ?? null;
    return { scheme: 'basic', user, presented: true };
  }
  const bearer = /^bearer\s+(.+)$/i.exec(header);
  if (bearer) {
    const user = state.users.find((u) => u.token === bearer[1]) ?? null;
    return { scheme: 'bearer', user, presented: true };
  }
  return { scheme: 'other', user: null, presented: true };
}

function normaliseFault(rule) {
  if (!FAULT_KINDS.has(rule.kind))
    throw new TypeError(`stub-tracker: unknown fault kind «${rule.kind}»`);
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

export async function startStubTracker(options = {}) {
  for (const key of Object.keys(options))
    if (!OPTION_KEYS.has(key)) throw new TypeError(`stub-tracker: unknown option «${key}»`);
  const { port = 0, trace, deployment = 'cloud' } = options;
  if (!Number.isInteger(port) || port < 0 || port > 65535)
    throw new RangeError(`stub-tracker: port ${port} is not a TCP port`);
  if (port >= RESERVED_PORTS.from && port <= RESERVED_PORTS.to)
    throw new RangeError(
      `stub-tracker: port ${port} is reserved (${RESERVED_PORTS.from}–${RESERVED_PORTS.to})`,
    );
  if (deployment !== 'cloud' && deployment !== 'server')
    throw new TypeError(`stub-tracker: unknown deployment «${deployment}»`);
  const state = createState(options);
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
      return { status: 200, body: state.snapshot() };
    if (path === '/__stub/issue' && method === 'POST')
      return { status: 200, body: { key: state.upsertIssue(body).key } };
    if (path === '/__stub/fault' && method === 'POST') {
      faults.push(normaliseFault(body));
      return { status: 200, body: { faults: faults.length } };
    }
    if (path === '/__stub/fault' && method === 'DELETE') {
      faults.length = 0;
      return { status: 200, body: { faults: 0 } };
    }
    return { status: 404, body: { message: 'no such control path' } };
  }

  async function handle(req, res) {
    const raw = await readBody(req);
    const url = new URL(req.url ?? '/', 'http://stub');
    const method = req.method ?? 'GET';
    const { body, json } = parse(raw);
    const jql = url.searchParams.get('jql');
    const entry = {
      at: state.now(),
      method,
      path: req.url ?? '/',
      ...(jql === null ? {} : { jql }),
      bodyHash: raw ? sha256(raw) : null,
      auth: null,
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
    const auth = authOf(req, state);
    entry.auth = auth.scheme;
    entry.tokenId = auth.user ? auth.user.name : auth.presented ? 'unknown' : null;
    const segments = url.pathname
      .split('/')
      .filter(Boolean)
      .map((s) => decodeURIComponent(s));
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
        send(res, {
          status: fault.status,
          body: { errorMessages: [`stub fault ${fault.status}`] },
          ...(fault.retryAfter === undefined
            ? {}
            : { headers: { 'retry-after': String(fault.retryAfter) } }),
        });
      else stalled.add(res);
      return;
    }
    const version = segments[0] === 'rest' && segments[1] === 'api' ? segments[2] : undefined;
    const known = version === '2' || (version === '3' && deployment === 'cloud');
    if (!known) {
      record({ ...entry, status: 404 });
      send(res, { status: 404, body: { errorMessages: ['Not Found'] } });
      return;
    }
    const scheme = deployment === 'cloud' ? 'basic' : 'bearer';
    if (!auth.user || auth.scheme !== scheme) {
      record({ ...entry, status: 401 });
      send(res, { status: 401, body: { errorMessages: ['You are not authenticated.'] } });
      return;
    }
    const ctx = {
      state,
      deployment,
      method,
      query: url.searchParams,
      body,
      actor: auth.user,
      baseUrl,
      apiRoot: `/rest/api/${version}`,
    };
    let reply;
    try {
      reply = handleJira(ctx, segments.slice(3)) ?? {
        status: 404,
        body: { errorMessages: ['Not Found'] },
      };
    } catch (error) {
      reply = {
        status: 400,
        body: { errorMessages: [error instanceof Error ? error.message : String(error)] },
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
        deployment,
        requests,
        tokens: Object.fromEntries(state.users.map((u) => [u.name, u.token])),
        users: state.users.map(({ name, email, displayName }) => ({ name, email, displayName })),
        upsertIssue: (seed) => state.upsertIssue(seed).key,
        state: state.snapshot,
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
