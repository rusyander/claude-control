#!/usr/bin/env node
/**
 * Поддельный CLI для хуков, которые панель на этой машине живьём не проверит: Gemini CLI и
 * Kimi Code здесь не установлены. Подделка делает ровно то, что их опубликованная документация
 * говорит о хуках, и больше ничего, — читает конфиг из ТОГО ЖЕ места, куда его кладёт человек по
 * README варианта, исполняет команду оболочкой, отдаёт вход в форме CLI и толкует ответ так же:
 *
 *   gemini — `~/.gemini/extensions/<имя>/hooks/hooks.json`, `${extensionPath}` → каталог расширения;
 *            вход: session_id, transcript_path, cwd, hook_event_name, timestamp (+ tool_name,
 *            tool_input у BeforeTool); таймаут в мс; отказ — код 2 (причина в stderr) или stdout
 *            `{decision: "deny"|"block", reason}` (docs/hooks/reference.md);
 *   kimi   — `~/.kimi/config.toml`, массив `[[hooks]]` {event, command, matcher, timeout}; вход:
 *            hook_event_name, session_id, cwd, tool_name, tool_input, tool_call_id; таймаут в
 *            секундах; отказ — код 2 или `hookSpecificOutput.permissionDecision == "deny"`
 *            (docs/en/customization/hooks.md, src kimi_cli/hooks/config.py).
 *
 * Запуск по имени из PATH (обёртка `gemini`/`kimi` зовёт этот файл с `--as`):
 *   gemini tool <имя> '<json входа>' | @<файл с json>   ·   gemini prompt '<текст>'
 * Вывод — одна строка JSON: {verdict: 'blocked'|'ran', reason?, hooks: <сколько исполнено>}.
 */
import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parse as parseToml } from '../../apps/server/node_modules/smol-toml/dist/index.js';

const args = process.argv.slice(2);
const asAt = args.indexOf('--as');
const cli = asAt >= 0 ? args.splice(asAt, 2)[1] : '';
const [kind, a, rawB] = args;
// `@<файл>` — вход инструмента файлом: JSON в строке argv cmd.exe режет по кавычкам.
const b = rawB?.startsWith('@') ? readFileSync(rawB.slice(1), 'utf8') : rawB;
const home = process.env.HOME || process.env.USERPROFILE || homedir();
const cwd = process.cwd();
const session = 'fake-session-1';

/** Одна команда хука оболочкой — как CLI: JSON во вход, код, stdout и stderr назад. */
function exec(command, input, timeoutMs, env = {}) {
  const res = spawnSync(command, {
    shell: true,
    input: JSON.stringify(input),
    encoding: 'utf8',
    timeout: timeoutMs,
    env: { ...process.env, ...env },
    windowsHide: true,
  });
  return { code: res.status, out: (res.stdout ?? '').trim(), err: (res.stderr ?? '').trim() };
}

const json = (text) => {
  try {
    return text ? JSON.parse(text) : null;
  } catch {
    return null;
  }
};

function gemini() {
  const root = join(home, '.gemini', 'extensions');
  const groups = [];
  for (const name of existsSync(root) ? readdirSync(root) : []) {
    const ext = join(root, name);
    const file = join(ext, 'hooks', 'hooks.json');
    if (!existsSync(join(ext, 'gemini-extension.json')) || !existsSync(file)) continue;
    const config = JSON.parse(readFileSync(file, 'utf8'));
    for (const [event, list] of Object.entries(config.hooks ?? {}))
      for (const group of list) groups.push({ ext, event, group });
  }
  const event = kind === 'tool' ? 'BeforeTool' : 'BeforeAgent';
  const target = kind === 'tool' ? a : '';
  const base = {
    session_id: session,
    transcript_path: join(home, '.gemini', 'tmp', 'chats', `${session}.json`),
    cwd,
    hook_event_name: event,
    timestamp: new Date().toISOString(),
  };
  const input =
    kind === 'tool' ? { ...base, tool_name: a, tool_input: json(b) ?? {} } : { ...base, prompt: a };
  let ran = 0;
  for (const { ext, event: on, group } of groups) {
    if (on !== event) continue;
    // Матчер инструмента — регулярное выражение (у событий жизненного цикла — точная строка).
    if (group.matcher && !new RegExp(group.matcher).test(target)) continue;
    for (const hook of group.hooks ?? []) {
      if (hook.type !== 'command') continue;
      const command = hook.command.replaceAll('${extensionPath}', ext);
      const res = exec(command, input, hook.timeout ?? 60_000, { GEMINI_PROJECT_DIR: cwd });
      ran += 1;
      if (res.code === 2) return { verdict: 'blocked', reason: res.err, hooks: ran };
      const out = json(res.out);
      if (res.code === 0 && (out?.decision === 'deny' || out?.decision === 'block'))
        return { verdict: 'blocked', reason: String(out.reason ?? ''), hooks: ran };
    }
  }
  return { verdict: 'ran', hooks: ran };
}

function kimi() {
  const file = join(home, '.kimi', 'config.toml');
  const config = existsSync(file) ? parseToml(readFileSync(file, 'utf8')) : {};
  const event = kind === 'tool' ? 'PreToolUse' : 'UserPromptSubmit';
  const target = kind === 'tool' ? a : '';
  const input =
    kind === 'tool'
      ? {
          hook_event_name: event,
          session_id: session,
          cwd,
          tool_name: a,
          tool_input: json(b) ?? {},
          tool_call_id: 'call_1',
        }
      : { hook_event_name: event, session_id: session, cwd, prompt: a };
  let ran = 0;
  for (const hook of config.hooks ?? []) {
    if (hook.event !== event) continue;
    // Пустой матчер — всё (HookDef.matcher = "").
    if (hook.matcher && !new RegExp(hook.matcher).test(target)) continue;
    const res = exec(hook.command, input, (hook.timeout ?? 30) * 1000);
    ran += 1;
    if (res.code === 2) return { verdict: 'blocked', reason: res.err, hooks: ran };
    const h = json(res.out)?.hookSpecificOutput;
    if (res.code === 0 && h?.permissionDecision === 'deny')
      return { verdict: 'blocked', reason: String(h.permissionDecisionReason ?? ''), hooks: ran };
  }
  return { verdict: 'ran', hooks: ran };
}

const run = { gemini, kimi }[cli];
if (!run || !['tool', 'prompt'].includes(kind)) {
  console.error('usage: fake-hook-cli --as gemini|kimi tool <name> <json> | prompt <text>');
  process.exit(64);
}
console.log(JSON.stringify(run()));
