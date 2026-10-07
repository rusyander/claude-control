// GitLab read access shared by review-sync and review-harvest — GET only, never a write.
// Goes through the user's own `glab` login (`glab auth login`): this kit never holds a forge token,
// never reads one from a file and never asks for one. The host comes from the repo's `origin` remote,
// so a self-hosted GitLab works without configuration.
// Test hook: AGENTDECK_GLAB_CMD = JSON array replacing the `glab` command (e.g. ["node","fake.mjs"]).
import { spawnSync } from 'node:child_process';

export const scrub = (s) => String(s).replace(/\/\/[^@/\s]*@/g, '//<userinfo>@');
export class HttpError extends Error {}
export const BOT = /bot\b|^ghost$|^project_\d+_bot/i;

const NOT_CONNECTED =
  'forge not connected — install glab and run `glab auth login` for this host, then re-run';

function glabCmd() {
  try {
    const c = JSON.parse(process.env.AGENTDECK_GLAB_CMD || 'null');
    if (Array.isArray(c) && c.length) return c.map(String);
  } catch {
    /* fall through to the real CLI */
  }
  return ['glab'];
}

function runGlab(args) {
  const [cmd, ...pre] = glabCmd();
  return spawnSync(cmd, [...pre, ...args], {
    encoding: 'utf8',
    timeout: 20000,
    maxBuffer: 64 * 1024 * 1024,
    windowsHide: true,
  });
}

// `host` of the `origin` remote of the repo holding `dir`; null outside a repo.
export function originHost(dir = process.cwd()) {
  const r = spawnSync('git', ['-C', dir, 'remote', 'get-url', 'origin'], { encoding: 'utf8' });
  if (r.status !== 0) return null;
  const m = r.stdout.trim().match(/^(?:[a-z+]+:\/\/(?:[^@/]*@)?([^/:]+)|[^@]+@([^:]+):)/i);
  return m?.[1] ?? m?.[2] ?? null;
}

/**
 * The connection the other helpers take. `api` is an empty prefix kept for the callers' URL building
 * (`${cred.api}/projects/…`); the real transport is `glab api`. `{ error }` when glab is missing or
 * not logged in — the caller reports it and exits 2, never asks for a token.
 */
export function secrets(dir = process.cwd()) {
  const host = process.env.GITLAB_HOST || originHost(dir) || '';
  const probe = runGlab(['auth', 'status', ...(host ? ['--hostname', host] : [])]);
  if (probe.error)
    return { error: `${NOT_CONNECTED} (glab: ${probe.error.code ?? probe.error.message})` };
  if (probe.status !== 0) return { error: `${NOT_CONNECTED}${host ? ` (host ${host})` : ''}` };
  return { api: '', host };
}

function parseInclude(out) {
  // `glab api --include`: status line + headers, blank line, body.
  const text = String(out ?? '');
  const sep = text.search(/\r?\n\r?\n/);
  const head = sep < 0 ? text : text.slice(0, sep);
  const body = sep < 0 ? '' : text.slice(sep).replace(/^\r?\n\r?\n/, '');
  const status = Number(head.match(/^HTTP\/[\d.]+\s+(\d{3})/)?.[1] ?? 0);
  const next = head.match(/^x-next-page:\s*(\S*)\s*$/im)?.[1] || null;
  return { status, next, body };
}

// Throws HttpError — never exits: process.exit with pending I/O aborts Node on Windows after an
// earlier report was already written.
export async function get(cred, url) {
  const endpoint = String(url).replace(/^\/+/, '');
  const shown = scrub(endpoint);
  const r = runGlab([
    'api',
    '--method',
    'GET',
    '--include',
    ...(cred.host ? ['--hostname', cred.host] : []),
    endpoint,
  ]);
  if (r.error)
    throw new HttpError(
      `GET ${shown} failed: ${r.error.code === 'ETIMEDOUT' ? 'timeout 20s' : scrub(r.error.message)}`,
    );
  const { status, next, body } = parseInclude(r.stdout);
  if (status === 401) throw new HttpError(`${NOT_CONNECTED} (401)`);
  if (status && (status < 200 || status >= 300))
    throw new HttpError(`HTTP ${status} on GET ${shown}`);
  if (!status && r.status !== 0)
    throw new HttpError(`GET ${shown} failed: ${scrub((r.stderr || '').trim().slice(0, 200))}`);
  let json;
  try {
    json = JSON.parse(body);
  } catch {
    throw new HttpError(`GET ${shown}: response is not JSON`);
  }
  return { body: json, next };
}

// Every page or nothing: a list cut at a failed page 2 reads as complete and rewrites the report from it.
export async function getAll(cred, url) {
  const all = [];
  for (let page = '1'; page;) {
    const r = await get(cred, `${url}${url.includes('?') ? '&' : '?'}per_page=100&page=${page}`);
    if (!Array.isArray(r.body)) throw new HttpError(`page ${page} of ${scrub(url)} is not a list`);
    all.push(...r.body);
    page = r.next;
  }
  return all;
}

// `grp/proj` from the `origin` remote of the repo holding `dir`; null outside a repo.
export function originProject(dir) {
  const r = spawnSync('git', ['-C', dir, 'remote', 'get-url', 'origin'], { encoding: 'utf8' });
  if (r.status !== 0) return null;
  // https://[user@]host/grp/proj(.git) or git@host:grp/proj(.git); userinfo is dropped, never printed.
  const m = r.stdout
    .trim()
    .match(/^(?:[a-z+]+:\/\/(?:[^@/]*@)?[^/]+\/|[^@]+@[^:]+:)(.+?)(?:\.git)?\/?$/i);
  return m?.[1] ?? null;
}
