// Подделка `goose acp` для тестов живого хода: ACP строками по stdio в той
// форме, что снята с настоящего Goose 1.53.0. Режим — FAKE_MODE: `ok` (ход ждёт
// сообщение посреди ответа до HOLD_MS), `permission` (инструмент просит
// разрешения), `tool` (инструмент ведёт себя по режиму сессии, как настоящий
// Goose: `auto` — выполняет БЕЗ вопроса, `approve` — спрашивает, `chat` —
// пропускает), `no-server` (подкоманды нет). Режим сессии — FAKE_GOOSE_MODE
// (по умолчанию `auto`, как у Goose), `session/set_mode` его меняет;
// FAKE_SET_MODE=error — метода нет. Удаление сессии и смена режима пишутся в
// stderr — тест видит, что сессия не осталась у Goose и какой режим просили.
// С FAKE_STORE сессии живут на «диске» (`fake-session-store.mjs`): агент объявляет
// `loadSession` (FAKE_LOAD=0 — нет), `session/load` проигрывает историю
// уведомлениями, как настоящий ACP-агент, и только потом отвечает. FAKE_MODE=fail —
// `session/prompt` отвечает ошибкой.
import { createInterface } from 'node:readline';
import { change, load, nextId, persistent, remove } from './fake-session-store.mjs';
import process from 'node:process';
import { setTimeout } from 'node:timers';

const mode = process.env.FAKE_MODE ?? 'ok';
const holdMs = Number(process.env.HOLD_MS ?? 400);
const MODES = ['auto', 'approve', 'smart_approve', 'chat'];
let sessionMode = process.env.FAKE_GOOSE_MODE ?? 'auto';
if (mode === 'no-server') {
  process.stderr.write("error: unrecognized subcommand 'acp'\n");
  process.exit(2);
}

const send = (message) =>
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
const update = (body) =>
  send({ method: 'session/update', params: { sessionId: 'ses-1', update: body } });
const runId = 'run-1';
let active = false;
let release;
let nextServerId = 100;
const answers = new Map();
let current = 'ses-1';
const modes = () => ({
  currentModeId: sessionMode,
  availableModes: MODES.map((id) => ({ id, name: id })),
});

createInterface({ input: process.stdin }).on('line', (line) => {
  const message = JSON.parse(line);
  if (message.id !== undefined && !message.method) {
    answers.get(message.id)?.(message.result);
    return;
  }
  switch (message.method) {
    case 'initialize':
      send({
        id: message.id,
        result: {
          protocolVersion: 1,
          agentCapabilities:
            persistent && process.env.FAKE_LOAD !== '0' ? { loadSession: true } : {},
        },
      });
      return;
    case 'session/new':
      if (persistent) {
        current = nextId('ses');
        change((state) => {
          state.sessions[current] = { prompts: [], replies: [] };
          state.log.push(`new ${current}`);
        });
      }
      send({ id: message.id, result: { sessionId: current, modes: modes() } });
      return;
    case 'session/load': {
      const known = load().sessions[message.params.sessionId];
      if (!known) {
        send({ id: message.id, error: { code: -32002, message: 'Resource not found' } });
        return;
      }
      current = message.params.sessionId;
      change((state) => state.log.push(`load ${current} cwd=${message.params.cwd}`));
      // Проигрыш истории — до ответа на `session/load`, теми же уведомлениями, что и ход.
      known.prompts.forEach((prompt, index) => {
        update({ sessionUpdate: 'user_message_chunk', content: { type: 'text', text: prompt } });
        update({
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: known.replies[index] ?? 'старый ответ' },
        });
      });
      update({
        sessionUpdate: 'session_info_update',
        _meta: { goose: { activeRunId: 'run-old' } },
      });
      update({ sessionUpdate: 'session_info_update', _meta: { goose: { activeRunId: null } } });
      send({ id: message.id, result: { modes: modes() } });
      return;
    }
    case 'session/set_mode':
      if (process.env.FAKE_SET_MODE === 'error' || !MODES.includes(message.params?.modeId)) {
        send({ id: message.id, error: { code: -32601, message: 'Method not found' } });
        return;
      }
      sessionMode = message.params.modeId;
      process.stderr.write(`set_mode ${sessionMode}\n`);
      update({ sessionUpdate: 'current_mode_update', currentModeId: sessionMode });
      send({ id: message.id, result: {} });
      return;
    case 'session/prompt':
      change((state) => state.sessions[current]?.prompts.push(message.params.prompt[0].text));
      if (mode === 'fail') {
        send({ id: message.id, error: { code: -32603, message: 'model refused' } });
        return;
      }
      active = true;
      void runTurn(message.id, message.params.prompt[0].text);
      return;
    case 'session/cancel':
      release?.('__cancel__');
      return;
    case '_goose/unstable/session/steer':
      if (!active || message.params.expectedRunId !== runId) {
        send({ id: message.id, error: { code: -32602, message: 'Invalid params' } });
        return;
      }
      send({ id: message.id, result: { runId, messageId: 'steer-1' } });
      release?.(message.params.prompt[0].text);
      return;
    case 'session/delete':
      remove(message.params.sessionId);
      process.stderr.write('session deleted\n');
      send({ id: message.id, result: {} });
      return;
    default:
      send({ id: message.id, error: { code: -32601, message: 'Method not found' } });
  }
});

function ask(method, params) {
  const id = nextServerId++;
  send({ id, method, params });
  return new Promise((resolve) => answers.set(id, resolve));
}

async function runTurn(promptId, prompt) {
  update({ sessionUpdate: 'session_info_update', _meta: { goose: { activeRunId: runId } } });
  update({
    sessionUpdate: 'agent_message_chunk',
    content: { type: 'text', text: `ответ на ${prompt.slice(-12)}` },
  });
  if (mode === 'tool' && sessionMode !== 'approve') {
    // Настоящий Goose в `auto` разрешения не спрашивает вовсе, в `chat` — пропускает инструмент.
    update({
      sessionUpdate: 'agent_message_chunk',
      content: {
        type: 'text',
        text: sessionMode === 'chat' ? ' / инструмент: пропущен' : ' / инструмент: без вопроса',
      },
    });
  }
  if (mode === 'permission' || (mode === 'tool' && sessionMode === 'approve')) {
    const result = await ask('session/request_permission', {
      sessionId: 'ses-1',
      toolCall: { toolCallId: 'call-1' },
      options: [
        { optionId: 'allow_once', kind: 'allow_once', name: 'Allow' },
        { optionId: 'reject_once', kind: 'reject_once', name: 'Reject' },
      ],
    });
    update({
      sessionUpdate: 'agent_message_chunk',
      content: {
        type: 'text',
        text: ` / разрешение: ${result.outcome.optionId ?? result.outcome.outcome}`,
      },
    });
  }
  const got = await new Promise((resolve) => {
    release = resolve;
    setTimeout(() => resolve(undefined), holdMs);
  });
  release = undefined;
  if (got && got !== '__cancel__') {
    update({ sessionUpdate: 'user_message_chunk', content: { type: 'text', text: got } });
    update({
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: `учёл: ${got}` },
    });
  }
  active = false;
  change((state) => state.sessions[current]?.replies.push(`ответ на ${prompt.slice(-12)}`));
  update({ sessionUpdate: 'session_info_update', _meta: { goose: { activeRunId: null } } });
  send({ id: promptId, result: { stopReason: got === '__cancel__' ? 'cancelled' : 'end_turn' } });
}
