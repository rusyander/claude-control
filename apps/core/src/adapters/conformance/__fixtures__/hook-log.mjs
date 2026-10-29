// Подставной хук для набора соответствия: дописывает в файл строку {role, key, input, env}
// и отвечает «разрешено» (код 0, пустой вывод). Роли: core (хук ядра), recorder (запись
// observe), user (хук человека — его вызов в observe/off означает утечку слоя).
// Запуск: node hook-log.mjs <role> --log <file> [--hook <key>] [--deny]
import { appendFileSync, readFileSync } from 'node:fs';

const argv = process.argv.slice(2);
const role = argv[0];
const at = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};
const file = at('--log');
const attempt = (read, fallback) => {
  try {
    return read();
  } catch {
    return fallback;
  }
};
const input = attempt(() => readFileSync(0, 'utf8'), '');
const parsed = attempt(() => JSON.parse(input), null);
const env = Object.fromEntries(
  Object.entries(process.env).filter(([k]) =>
    // `PROBE_` — метки окружения из настроек репозитория (F-86: недоверенная копия их не грузит).
    /^(AGENTDECK_|CLAUDE_CODE_MAX_CONTEXT|API_TIMEOUT|PROBE_)/.test(k),
  ),
);
if (file) {
  appendFileSync(
    file,
    `${JSON.stringify({ role, key: at('--hook') ?? null, event: parsed?.hook_event_name ?? null, tool: parsed?.tool_name ?? null, env })}\n`,
  );
}
// `--deny`: блокирующий отказ хука (код 2, причина в stderr) — так хук ядра запрещает вызов.
if (argv.includes('--deny')) {
  process.stderr.write(`denied by ${role} hook`);
  process.exit(2);
}
process.exit(0);
