#!/usr/bin/env node
// Подставной Cursor Agent (`cursor-agent acp`) для проверки переходника без входа Cursor: ACP по
// stdio, ход = два вызова оболочки (`git status`, затем `git push origin main`), затем текст
// `P81_DONE`. На каждый вызов: вопрос о праве (`session/request_permission`), затем хуки
// `preToolUse` из `~/.cursor/hooks.json` (дом — `HOME`, на Windows `USERPROFILE`) — так, как
// их описывает документация хуков Cursor: stdin JSON (`tool_name`, `tool_input`), код 2 или
// `{"permission":"deny"}` — отказ, иной ненулевой код — отказ только при `failClosed`. Затем
// команда исполняется оболочкой. Поведение живого CLI НЕ проверено — это допущение переходника.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

const send = (msg) => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...msg })}\n`);
const SESSION = 'cursor-fake-session';
const COMMANDS = ['git status', 'git push origin main'];
const waiting = new Map();
let nextAsk = 1000;

function hooks() {
  const home = (process.platform === 'win32' ? process.env.USERPROFILE : process.env.HOME) || '';
  const dir = join(home, '.cursor');
  const file = join(dir, 'hooks.json');
  if (!existsSync(file)) return [];
  const doc = JSON.parse(readFileSync(file, 'utf8'));
  return Array.isArray(doc?.hooks?.preToolUse) ? doc.hooks.preToolUse : [];
}

/** Решение хуков: `null` — разрешено, строка — причина отказа. */
function runHooks(command) {
  const stdin = JSON.stringify({
    hook_event_name: 'preToolUse',
    conversation_id: SESSION,
    tool_name: 'Shell',
    tool_input: { command },
    workspace_roots: [process.cwd()],
  });
  for (const hook of hooks()) {
    const got = spawnSync(hook.command, {
      input: stdin,
      shell: true,
      encoding: 'utf8',
      env: process.env,
    });
    let verdict;
    try {
      verdict = JSON.parse(got.stdout.trim() || 'null');
    } catch {
      verdict = null;
    }
    if (verdict?.permission === 'deny') return `denied by hook: ${verdict.user_message ?? ''}`;
    if (got.status === 2) return `denied by hook: ${got.stderr.trim()}`;
    if (got.status !== 0 && hook.failClosed === true) return `hook failed (${got.status}), denied`;
  }
  return null;
}

function update(update) {
  send({ method: 'session/update', params: { sessionId: SESSION, update } });
}

function ask(toolCall) {
  const id = nextAsk++;
  send({
    id,
    method: 'session/request_permission',
    params: {
      sessionId: SESSION,
      toolCall,
      options: [
        { optionId: 'allow-once', name: 'Allow', kind: 'allow_once' },
        { optionId: 'allow-always', name: 'Always allow', kind: 'allow_always' },
        { optionId: 'reject-once', name: 'Reject', kind: 'reject_once' },
      ],
    },
  });
  return new Promise((resolve) => waiting.set(id, resolve));
}

const failed = (toolCallId, why) =>
  update({
    sessionUpdate: 'tool_call_update',
    toolCallId,
    status: 'failed',
    content: [{ type: 'content', content: { type: 'text', text: why } }],
  });

async function prompt(id) {
  let n = 0;
  for (const command of COMMANDS) {
    n += 1;
    const toolCallId = `call_${n}`;
    const call = {
      toolCallId,
      title: command,
      kind: 'execute',
      status: 'pending',
      rawInput: { command },
    };
    update({ sessionUpdate: 'tool_call', ...call });
    const answer = await ask(call);
    const chosen = answer?.outcome?.outcome === 'selected' ? answer.outcome.optionId : null;
    if (chosen !== 'allow-once' && chosen !== 'allow-always') {
      failed(toolCallId, 'rejected by user');
      continue;
    }
    const denied = runHooks(command);
    if (denied) {
      failed(toolCallId, denied);
      continue;
    }
    update({ sessionUpdate: 'tool_call_update', toolCallId, status: 'in_progress' });
    const ran = spawnSync(command, { shell: true, encoding: 'utf8', env: process.env });
    const out = `${ran.stdout ?? ''}${ran.stderr ?? ''}` || `exit ${ran.status}`;
    update({
      sessionUpdate: 'tool_call_update',
      toolCallId,
      status: ran.status === 0 ? 'completed' : 'failed',
      content: [{ type: 'content', content: { type: 'text', text: out } }],
    });
  }
  update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'P81_DONE' } });
  send({ id, result: { stopReason: 'end_turn' } });
}

const rl = createInterface({ input: process.stdin });
rl.on('line', (line) => {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  if (msg.method === undefined && waiting.has(msg.id)) {
    const resolve = waiting.get(msg.id);
    waiting.delete(msg.id);
    resolve(msg.result);
    return;
  }
  if (msg.method === 'initialize') {
    send({
      id: msg.id,
      result: {
        protocolVersion: 1,
        agentCapabilities: {},
        authMethods: [],
        agentInfo: { name: 'fake-cursor-agent' },
      },
    });
  } else if (msg.method === 'session/new') {
    send({ id: msg.id, result: { sessionId: SESSION } });
  } else if (msg.method === 'session/prompt') {
    void prompt(msg.id);
  } else if (msg.id !== undefined) {
    send({ id: msg.id, error: { code: -32601, message: `fake cursor: ${msg.method}` } });
  }
});
rl.on('close', () => process.exit(0));
