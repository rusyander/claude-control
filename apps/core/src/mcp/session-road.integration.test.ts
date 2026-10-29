import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { CORE_VARS } from '../adapters/launcher/env.ts';
import { readJournalLines } from '../journal/read-lines.ts';
import { newId } from '../lib/ids/uuidv7.ts';
import { createSessionTokens } from '../policy/session-tokens/session-tokens.ts';
import { callText, rpcOver } from './__fixtures__/rpc.ts';
import { PERMIT_SELF, startSessionStand, type SessionStand } from './__fixtures__/session-stand.ts';
import { MCP_RUN } from './main.ts';

/**
 * Дорога сессии целиком: настоящий процесс моста (`run.ts`) по stdio, как его запускает CLI, →
 * настоящий API ядра → журнал. И обратная сторона (P41): настоящий токен сессии на дороге
 * человека — отказ и `signal forged-authority`; чужой или подделанный токен на дороге сессии —
 * 401 до журнала.
 */

const children: ChildProcessWithoutNullStreams[] = [];
let stand: SessionStand | undefined;

afterEach(async () => {
  for (const child of children.splice(0)) child.kill();
  await stand?.close();
  stand = undefined;
});

function bridge(which: string, env: Record<string, string>) {
  const child = spawn(
    process.execPath,
    ['--experimental-strip-types', '--no-warnings', MCP_RUN, which],
    {
      env: { ...process.env, ...env },
      stdio: 'pipe',
    },
  );
  children.push(child);
  return { child, rpc: rpcOver(child) };
}

function sessionEnv(s: SessionStand, token = s.sessionToken): Record<string, string> {
  return { [CORE_VARS.coreUrl]: s.url, [CORE_VARS.access]: token };
}

function journal(s: SessionStand) {
  return readJournalLines(s.task.dir, s.task.taskId).lines;
}

const signals = (s: SessionStand) =>
  journal(s)
    .filter((l) => l.kind === 'signal')
    .map((l) => (l.data as { signal: string }).signal);

describe('session road: MCP bridges to the core', () => {
  it('agentdeck bridge lists the tools of its step kind and carries calls to the core journal', async () => {
    stand = await startSessionStand({ stepKind: 'review' });
    const s = stand;
    const { rpc } = bridge('agentdeck', sessionEnv(s));
    const init = (await rpc.request('initialize', { protocolVersion: '2025-06-18' })) as {
      protocolVersion: string;
      serverInfo: { name: string };
    };
    expect(init).toMatchObject({
      protocolVersion: '2025-06-18',
      serverInfo: { name: 'agentdeck' },
    });
    const listed = (await rpc.request('tools/list')) as { tools: { name: string }[] };
    expect(listed.tools.map((t) => t.name)).toEqual([
      'step_done',
      'check',
      'ask_human',
      'blocker',
      'core_state',
    ]);
    const state = callText(await rpc.request('tools/call', { name: 'core_state', arguments: {} }));
    expect(state).toMatchObject({
      isError: false,
      body: { ok: true, result: { step: { stepId: s.session.stepId, kind: 'review' } } },
    });
    const bad = callText(
      await rpc.request('tools/call', {
        name: 'step_done',
        arguments: { stepId: s.session.stepId },
      }),
    );
    expect(bad).toMatchObject({ isError: true, body: { ok: false, code: 'invalid' } });
    expect(signals(s)).toEqual(['step-done-invalid']);
  });

  it('agentdeck-permit bridge: no pending request → denied + forged-authority; a pending request is answered', async () => {
    stand = await startSessionStand();
    const s = stand;
    const { rpc } = bridge('permit', sessionEnv(s));
    await rpc.request('initialize', {});
    const listed = (await rpc.request('tools/list')) as { tools: { name: string }[] };
    expect(listed.tools.map((t) => t.name)).toEqual(['approve']);
    const forged = callText(
      await rpc.request('tools/call', {
        name: 'approve',
        arguments: { tool_name: 'Bash', input: { command: 'ls' }, tool_use_id: 'toolu_none' },
      }),
    );
    expect(forged).toMatchObject({ isError: false, body: { behavior: 'deny' } });
    expect(signals(s)).toEqual(['forged-authority']);
    s.gate.observe(s.session.sessionId, {
      type: 'tool.requested',
      toolUseId: 'toolu_ok',
      name: 'Read',
      input: { file_path: 'a.ts' },
      cliInitiated: false,
    });
    const allowed = callText(
      await rpc.request('tools/call', {
        name: 'approve',
        arguments: { tool_name: 'Read', input: { file_path: 'a.ts' }, tool_use_id: 'toolu_ok' },
      }),
    );
    expect(allowed).toMatchObject({
      body: { behavior: 'allow', updatedInput: { file_path: 'a.ts' } },
    });
    // Модель зовёт сервер права сама — тоже подделка.
    s.gate.observe(s.session.sessionId, {
      type: 'tool.requested',
      toolUseId: 'toolu_self',
      name: PERMIT_SELF,
      input: {},
      cliInitiated: false,
    });
    const self = callText(
      await rpc.request('tools/call', {
        name: 'approve',
        arguments: { tool_name: PERMIT_SELF, input: {}, tool_use_id: 'toolu_self' },
      }),
    );
    expect(self).toMatchObject({ body: { behavior: 'deny' } });
    expect(signals(s)).toEqual(['forged-authority', 'forged-authority']);
  });

  it('a bridge with the core token instead of a session token gets nothing; without env it does not start', async () => {
    stand = await startSessionStand();
    const s = stand;
    const { rpc } = bridge('agentdeck', sessionEnv(s, s.coreToken));
    await rpc.request('initialize', {});
    await expect(rpc.request('tools/list')).rejects.toThrow(/401|session-token-required/);
    const bare = spawn(
      process.execPath,
      ['--experimental-strip-types', '--no-warnings', MCP_RUN, 'agentdeck'],
      {
        env: { ...process.env, [CORE_VARS.coreUrl]: '', [CORE_VARS.access]: '' },
      },
    );
    const code = await new Promise<number | null>((done) => bare.on('exit', done));
    expect(code).toBe(2);
  });
});

describe('P41 session token on the authority road', () => {
  it('a real session token on a one-shot command (fresh-rerun) is refused as forged and journaled; it reads nothing', async () => {
    stand = await startSessionStand();
    const s = stand;
    const nonce = (await (
      await fetch(`${s.url}/v1/nonce?page=${newId()}`, {
        headers: { authorization: `Bearer ${s.coreToken}` },
      })
    ).json()) as { nonce: string; page: string };
    const res = await fetch(`${s.url}/v1/commands`, {
      method: 'POST',
      headers: { authorization: `Bearer ${s.sessionToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        cmdId: newId(),
        kind: 'fresh-rerun',
        target: { taskId: s.task.taskId },
        fields: { scope: 'check', ref: 'unit' },
        proof: { nonce: nonce.nonce, page: nonce.page },
      }),
    });
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: 'forged-authority' });
    expect(signals(s)).toEqual(['forged-authority']);
    // Чтение панели токеном сессии закрыто: ни задач, ни числа страницы.
    for (const path of ['/v1/tasks', `/v1/tasks/${s.task.taskId}`, `/v1/nonce?page=${newId()}`]) {
      const read = await fetch(`${s.url}${path}`, {
        headers: { authorization: `Bearer ${s.sessionToken}` },
      });
      expect(read.status, path).toBe(401);
    }
  });

  it('session routes take only a live session token: core token, foreign key, edited token → 401; ended session → 403', async () => {
    stand = await startSessionStand();
    const s = stand;
    const call = (token: string) =>
      fetch(`${s.url}/v1/session/tools/core_state`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ input: {} }),
      });
    expect((await call(s.sessionToken)).status).toBe(200);
    expect((await call(s.coreToken)).status).toBe(401);
    const foreign = createSessionTokens('another-core-token-123456').mint({
      taskId: s.task.taskId,
      sessionId: s.session.sessionId,
    });
    expect((await call(foreign)).status).toBe(401);
    const otherSession = s.tokens.mint({ taskId: s.task.taskId, sessionId: newId() });
    expect((await call(otherSession)).status).toBe(403);
    const before = s.task.state.seq;
    s.task.append({
      kind: 'session.transition',
      actor: 'core',
      sessionId: s.session.sessionId,
      data: { sessionId: s.session.sessionId, event: 'exited', from: 'live', to: 'ended' },
    });
    const ended = await call(s.sessionToken);
    expect(ended.status).toBe(403);
    expect(await ended.json()).toMatchObject({ code: 'session-ended' });
    expect(s.task.state.seq).toBe(before + 1);
  });
});
