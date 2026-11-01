// Хук живых проб слоя (этап 7): дописывает в журнал строку {role, input} — вход хука целиком
// (поле `prompt`, `agent_id` подагента) — и отвечает по режиму.
// Запуск: node layer-hook.mjs <role> <log> [allow|exit2|json-deny|block] [сколько раз отказывать]
// exit2 — код 2 и причина в stderr; json-deny — PreToolUse `permissionDecision: deny`;
// block — `decision: block` (UserPromptSubmit, Stop). После N отказов — «разрешено».
import { appendFileSync, existsSync, readFileSync } from 'node:fs';

const [role, log, mode = 'allow', timesArg = '999'] = process.argv.slice(2);
let raw = '';
try {
  raw = readFileSync(0, 'utf8');
} catch {
  // stdin закрыт — вход пуст.
}
let input;
try {
  input = JSON.parse(raw);
} catch {
  input = raw;
}
const prior = existsSync(log)
  ? readFileSync(log, 'utf8')
      .split('\n')
      .filter((line) => line.includes(`"role":${JSON.stringify(role)}`)).length
  : 0;
appendFileSync(log, `${JSON.stringify({ role, input })}\n`);
if (prior >= Number(timesArg) || mode === 'allow') process.exit(0);
if (mode === 'exit2') {
  process.stderr.write(`${role.toUpperCase()}_EXIT2_REASON`);
  process.exit(2);
}
if (mode === 'json-deny') {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: `${role.toUpperCase()}_JSON_REASON`,
      },
    }),
  );
  process.exit(0);
}
if (mode === 'block') {
  process.stdout.write(
    JSON.stringify({ decision: 'block', reason: `${role.toUpperCase()}_BLOCK_${prior}` }),
  );
  process.exit(0);
}
process.exit(0);
