import { spawn } from 'node:child_process';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { CORE_VARS } from '../adapters/launcher/env.ts';
import { HOOK_WAIT_VAR } from './hook.ts';
import { HOOK_MODE, MCP_RUN } from './main.ts';

/**
 * Хук ядра как процесс — так, как его зовёт CLI: `node run.ts hook`, вызов инструмента на stdin,
 * ответ кодом выхода. Ядро здесь — подставной HTTP-сервер: проверяется, что хук несёт вызов
 * с токеном сессии и отвечает по решению, а всё прочее (нет окружения, мусор, ядро молчит,
 * ответ без решения) — отказ, никогда не «разрешено».
 */

interface Seen {
  path: string;
  auth: string;
  body: unknown;
}

const servers: Server[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) await new Promise((r) => server.close(r));
});

async function core(answers: { status: number; body: unknown }[]): Promise<{
  url: string;
  seen: Seen[];
}> {
  const seen: Seen[] = [];
  const server = createServer((req: IncomingMessage, res) => {
    let text = '';
    req.on('data', (chunk: Buffer) => (text += chunk.toString('utf8')));
    req.on('end', () => {
      seen.push({
        path: req.url ?? '',
        auth: req.headers.authorization ?? '',
        body: text ? JSON.parse(text) : null,
      });
      const answer = answers[Math.min(seen.length - 1, answers.length - 1)]!;
      res.writeHead(answer.status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(answer.body));
    });
  });
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, seen };
}

function hook(
  env: Record<string, string>,
  stdin: string,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((done) => {
    const child = spawn(
      process.execPath,
      ['--experimental-strip-types', '--no-warnings', MCP_RUN, HOOK_MODE],
      {
        env: { PATH: process.env.PATH ?? '', SystemRoot: process.env.SystemRoot ?? '', ...env },
        stdio: 'pipe',
        windowsHide: true,
      },
    );
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c: Buffer) => (stdout += c.toString('utf8')));
    child.stderr.on('data', (c: Buffer) => (stderr += c.toString('utf8')));
    child.on('close', (code) => done({ code, stdout, stderr }));
    child.stdin.end(stdin);
  });
}

const CALL = JSON.stringify({
  hook_event_name: 'PreToolUse',
  tool_name: 'Bash',
  tool_input: { command: 'git push' },
});
const sessionEnv = (url: string): Record<string, string> => ({
  [CORE_VARS.coreUrl]: url,
  [CORE_VARS.access]: 'FAKE-VENDOR-session-token',
});

describe('core hook process: the CLI asks, the core decides, the exit code answers', () => {
  it('allowed by the core → exit 0 with empty output; the call went with the session token', async () => {
    const c = await core([{ status: 200, body: { allow: true, reason: 'ok' } }]);
    const got = await hook(sessionEnv(c.url), CALL);
    expect(got).toMatchObject({ code: 0, stdout: '' });
    expect(c.seen).toEqual([
      {
        path: '/v1/session/hook',
        auth: 'Bearer FAKE-VENDOR-session-token',
        body: { tool: 'Bash', input: { command: 'git push' } },
      },
    ]);
  }, 30_000);

  it('denied by the core → exit 2, the reason on stderr for the model', async () => {
    const c = await core([
      { status: 200, body: { allow: false, reason: 'publish is a platform step' } },
    ]);
    const got = await hook(sessionEnv(c.url), CALL);
    expect(got.code).toBe(2);
    expect(got.stderr).toContain('Denied by the platform: publish is a platform step.');
  }, 30_000);

  it('an unreadable tool call → exit 2 before the core is asked', async () => {
    const c = await core([{ status: 200, body: { allow: true } }]);
    for (const stdin of [
      'not json',
      '{"tool_input":{}}',
      '{"tool_name":"Bash","tool_input":"x"}',
    ]) {
      expect((await hook(sessionEnv(c.url), stdin)).code).toBe(2);
    }
    expect(c.seen).toEqual([]);
  }, 30_000);

  it('no session env → exit 2, the missing variable named', async () => {
    const got = await hook({}, CALL);
    expect(got.code).toBe(2);
    expect(got.stderr).toContain(CORE_VARS.coreUrl);
  }, 30_000);

  it('the core does not answer → exit 2 (not «allowed»)', async () => {
    const c = await core([]);
    const url = c.url;
    await new Promise((r) => servers.pop()!.close(r));
    const got = await hook({ ...sessionEnv(url), [HOOK_WAIT_VAR]: '600' }, CALL);
    expect(got.code).toBe(2);
    expect(got.stderr).toMatch(/core unreachable/);
  }, 30_000);

  it('503 (session not attached yet) is retried; the decision after it counts', async () => {
    const c = await core([
      { status: 503, body: { code: 'permit-unavailable' } },
      { status: 200, body: { allow: true } },
    ]);
    const got = await hook(sessionEnv(c.url), CALL);
    expect(got.code).toBe(0);
    expect(c.seen).toHaveLength(2);
  }, 30_000);

  it('a 200 without a decision, or a refusal status → exit 2', async () => {
    const empty = await core([{ status: 200, body: { ok: true } }]);
    expect((await hook(sessionEnv(empty.url), CALL)).code).toBe(2);
    const refused = await core([{ status: 403, body: { code: 'forged' } }]);
    const got = await hook(sessionEnv(refused.url), CALL);
    expect(got.code).toBe(2);
    expect(got.stderr).toContain('403');
  }, 30_000);
});
