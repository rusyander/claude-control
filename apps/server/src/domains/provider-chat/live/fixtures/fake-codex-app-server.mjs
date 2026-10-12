// Подделка `codex app-server` для тестов живого хода: JSON-RPC строками по stdio
// в той форме, что печатает настоящий CLI 0.160.0 (`generate-ts`). Режим —
// переменная FAKE_MODE: `ok` (ход ждёт сообщение посреди ответа до HOLD_MS),
// `no-server` (подкоманды нет — процесс сразу выходит), `fail` (ход падает),
// `permission` (ход спрашивает `item/fileChange/requestApproval` и печатает ответ
// клиента и права, с которыми открыт поток).
// С FAKE_STORE потоки живут на «диске» (`fake-session-store.mjs`): `thread/resume`
// поднимает записанный не-ephemeral поток, `thread/delete` его стирает.
import { createInterface } from 'node:readline';
import { change, load, nextId, persistent, remove } from './fake-session-store.mjs';
import process from 'node:process';
import { setTimeout } from 'node:timers';

const mode = process.env.FAKE_MODE ?? 'ok';
const holdMs = Number(process.env.HOLD_MS ?? 400);
if (mode === 'no-server') {
  process.stderr.write("error: unrecognized subcommand 'app-server'\n");
  process.exit(2);
}

const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
let active = false;
let release;
let rights = '';
let answer;
let thread = 'thr-1';

createInterface({ input: process.stdin }).on('line', (line) => {
  const message = JSON.parse(line);
  switch (message.method) {
    case 'initialize':
      send({ id: message.id, result: { userAgent: 'fake' } });
      return;
    case 'thread/start': {
      rights = `${message.params.sandbox ?? 'нет'}/${message.params.approvalPolicy ?? 'нет'}`;
      if (persistent) {
        thread = nextId('thr');
        const ephemeral = message.params.ephemeral === true;
        change((state) => {
          state.sessions[thread] = { prompts: [], ephemeral };
          state.log.push(`start ${thread} ephemeral=${ephemeral}`);
        });
      }
      send({ id: message.id, result: { thread: { id: thread } } });
      return;
    }
    case 'thread/resume': {
      const known = load().sessions[message.params.threadId];
      if (!known || known.ephemeral) {
        send({
          id: message.id,
          error: { code: -32600, message: 'no rollout found for thread id' },
        });
        return;
      }
      thread = message.params.threadId;
      rights = `${message.params.sandbox ?? 'нет'}/${message.params.approvalPolicy ?? 'нет'}`;
      change((state) =>
        state.log.push(
          `resume ${thread} cwd=${message.params.cwd ?? ''} ephemeral=${message.params.ephemeral ?? '-'} excludeTurns=${message.params.excludeTurns}`,
        ),
      );
      send({ id: message.id, result: { thread: { id: thread } } });
      return;
    }
    case 'thread/delete':
      remove(message.params.threadId);
      send({ id: message.id, result: {} });
      return;
    case 'turn/start':
      change((state) => state.sessions[thread]?.prompts.push(message.params.input[0].text));
      send({ id: message.id, result: { turn: { id: 'turn-1' } } });
      active = true;
      void runTurn(message.params.input[0].text);
      return;
    case 'turn/steer':
      if (!active || message.params.expectedTurnId !== 'turn-1') {
        send({ id: message.id, error: { code: -32600, message: 'no active turn to steer' } });
        return;
      }
      send({ id: message.id, result: { turnId: 'turn-1' } });
      release?.(message.params.input[0].text);
      return;
    default:
      // Ответ клиента на вопрос сервера (`id` без `method`).
      if (message.id === 'srv-1') answer?.(message);
      return;
  }
});

async function runTurn(prompt) {
  send({ method: 'item/started', params: { item: { type: 'agentMessage' } } });
  send({ method: 'item/agentMessage/delta', params: { delta: 'ответ на ' } });
  send({ method: 'item/agentMessage/delta', params: { delta: prompt.slice(-12) } });
  if (mode === 'permission') {
    const reply = await new Promise((resolve) => {
      answer = resolve;
      // FAKE_APPROVAL=command — просьба о команде, как у настоящего 0.160 на вызов
      // `exec_command` (живой прогон); иначе — о правке файла.
      send(
        process.env.FAKE_APPROVAL === 'command'
          ? {
              id: 'srv-1',
              method: 'item/commandExecution/requestApproval',
              params: {
                threadId: 'thr-1',
                turnId: 'turn-1',
                itemId: 'item-1',
                command: 'Set-Content probe.txt edited',
                cwd: process.cwd(),
              },
            }
          : {
              id: 'srv-1',
              method: 'item/fileChange/requestApproval',
              params: {
                threadId: 'thr-1',
                turnId: 'turn-1',
                itemId: 'item-1',
                startedAtMs: Date.now(),
                reason: 'write probe.txt',
              },
            },
      );
    });
    const decision = reply.result?.decision ?? `ошибка ${reply.error?.code}`;
    send({
      method: 'item/agentMessage/delta',
      params: { delta: ` разрешение: ${decision}; права: ${rights}` },
    });
    active = false;
    send({ method: 'turn/completed', params: { turn: { status: 'completed', error: null } } });
    return;
  }
  if (mode === 'fail') {
    active = false;
    send({
      method: 'turn/completed',
      params: { turn: { status: 'failed', error: { message: 'model refused' } } },
    });
    return;
  }
  const steered = await new Promise((resolve) => {
    release = resolve;
    setTimeout(() => resolve(undefined), holdMs);
  });
  if (steered) {
    send({ method: 'item/started', params: { item: { type: 'agentMessage' } } });
    send({ method: 'item/agentMessage/delta', params: { delta: `учёл: ${steered}` } });
  }
  active = false;
  send({ method: 'turn/completed', params: { turn: { status: 'completed', error: null } } });
}
