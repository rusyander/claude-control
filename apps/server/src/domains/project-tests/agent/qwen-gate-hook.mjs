// Хук PreToolUse Qwen Code на прогоне тестов: каждый вызов инструмента — к приёмнику
// прав панели (`run-permissions.ts startPermissionGate`), его ответ — Qwen.
//
// Qwen идёт в `yolo`, и, кроме этого хука, вызов не останавливает никто. Сам Qwen при
// сбое хука пропускает вызов (проба P3: тайм-аут, код 1, мусор в stdout, пустой вывод,
// пропавший скрипт — инструмент исполняется). Поэтому любая неясность здесь — ОТКАЗ:
// JSON отказа в stdout и код 2 (его Qwen тоже считает отказом, причина — stderr).
// Последнюю страховку — инструмент, исполненный без решения панели, — держит сторож
// прогона (`qwen-run.ts`), по `tool_call_id`, который хук передаёт приёмнику.
//
// Запуск: node qwen-gate-hook.mjs <gate.json>, где gate.json = {url, runId}.
/* global process, Buffer, fetch, AbortSignal */
import { readFileSync } from 'node:fs';

/** Своё ожидание короче ожидания Qwen (`QWEN_GATE_HOOK_TIMEOUT_MS`, 15 с). */
export const GATE_WAIT_MS = 8000;

function emit(decision, reason) {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: decision,
        permissionDecisionReason: reason,
      },
    }),
  );
}

/** Отказ по сбою: оба канала, которые Qwen считает отказом. */
function failClosed(why) {
  const reason = `The panel could not check this call (${why}), so it is refused. Try again; if it repeats, stop and report it in the case note.`;
  emit('deny', reason);
  process.stderr.write(reason);
  process.exit(2);
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

async function main() {
  const gateFile = process.argv[2];
  if (!gateFile) return failClosed('no gate file');
  let gate;
  try {
    gate = JSON.parse(readFileSync(gateFile, 'utf8'));
  } catch {
    return failClosed('gate file unreadable');
  }
  if (typeof gate?.url !== 'string' || typeof gate?.runId !== 'string') {
    return failClosed('gate file malformed');
  }
  let input;
  try {
    input = JSON.parse(await readStdin());
  } catch {
    return failClosed('hook input is not JSON');
  }
  const toolName = input?.tool_name;
  if (typeof toolName !== 'string' || !toolName) return failClosed('no tool name');

  let answer;
  try {
    const response = await fetch(gate.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        runId: gate.runId,
        toolName,
        input: input.tool_input ?? {},
        toolCallId: typeof input.tool_call_id === 'string' ? input.tool_call_id : undefined,
      }),
      signal: AbortSignal.timeout(GATE_WAIT_MS),
    });
    answer = await response.json();
  } catch (error) {
    return failClosed(`gate unreachable: ${error?.name ?? 'error'}`);
  }
  if (answer?.behavior === 'allow') {
    // Разрешено — молча: Qwen в yolo исполнит вызов сам.
    process.exit(0);
  }
  if (answer?.behavior === 'deny') {
    emit('deny', String(answer.message || 'Refused by the panel for this test run.'));
    process.exit(0);
  }
  return failClosed('gate answer malformed');
}

main().catch(() => failClosed('hook crashed'));
