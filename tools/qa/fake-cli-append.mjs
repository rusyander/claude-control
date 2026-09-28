/**
 * Исходник фальшивого `claude` для проверок того, что ДОШЛО до процесса чата:
 * рабочая папка, добавка к системному промпту (`--append-system-prompt[-file]`)
 * и текст хода. Стенд кладёт его первым в PATH панели (`throwaway-stand.mjs`,
 * `fakeCli: { claude: FAKE_APPEND_CLI }`); каждый ход — строка в `turns.jsonl`
 * рядом со скриптом. Отвечает одним сообщением «Done.».
 *
 * Экспорт — строка: её исходник пишется в файл стенда.
 */
export const FAKE_APPEND_CLI = String.raw`
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
const self = fileURLToPath(import.meta.url);
const LOG = self.replace(/[^\\/]+$/, 'turns.jsonl');
// Стенд снимает метку перед остановкой — процесс разговора уходит сам.
const ALIVE = self.replace(/[^\\/]+$/, '.stand-alive');
setInterval(() => {
  if (!existsSync(ALIVE)) process.exit(0);
}, 250).unref();

if (args.includes('--version') || args[0] === '-v') {
  process.stdout.write('2.1.0 (Claude Code)\n');
  process.exit(0);
}
const after = (flag) => {
  const at = args.indexOf(flag);
  return at >= 0 ? args[at + 1] : undefined;
};
const file = after('--append-system-prompt-file');
const append = (file && existsSync(file) ? readFileSync(file, 'utf8') : '') || after('--append-system-prompt') || '';
const streaming = after('--output-format') === 'stream-json';
const live = after('--input-format') === 'stream-json';
const sid = after('--resume') || after('--session-id') || 'sess-' + process.pid;
// Транскрипт, как у настоящего CLI: без него второй ход того же чата панель
// отклоняет («транскрипта с таким sessionId нет»).
const transcriptDir = join(process.env.CLAUDE_CONFIG_DIR || '.', 'projects', process.cwd().replace(/[^A-Za-z0-9]/g, '-'));
function transcript(role, text) {
  mkdirSync(transcriptDir, { recursive: true });
  appendFileSync(
    join(transcriptDir, sid + '.jsonl'),
    JSON.stringify({ type: role, sessionId: sid, cwd: process.cwd(), timestamp: new Date().toISOString(), message: { role, content: role === 'user' ? text : [{ type: 'text', text }] } }) + '\n',
  );
}
const out = (o) => process.stdout.write(JSON.stringify(o) + '\n');

function reply(prompt) {
  appendFileSync(LOG, JSON.stringify({ cwd: process.cwd(), live, append, prompt, at: Date.now() }) + '\n');
  const text = 'Done.';
  transcript('user', prompt);
  transcript('assistant', text);
  if (!streaming) {
    process.stdout.write(text);
    return;
  }
  out({ type: 'system', subtype: 'init', session_id: sid, model: 'claude-x', tools: [] });
  out({ type: 'assistant', session_id: sid, message: { id: 'm' + Date.now(), role: 'assistant', content: [{ type: 'text', text }] } });
  out({ type: 'result', subtype: 'success', is_error: false, result: text, session_id: sid, total_cost_usd: 0, duration_ms: 1, num_turns: 1 });
}

const textOf = (line) => {
  try {
    const msg = JSON.parse(line);
    if (msg.type !== 'user') return undefined;
    const content = msg.message?.content;
    return typeof content === 'string' ? content : (content ?? []).map((part) => part.text ?? '').join('');
  } catch {
    return undefined;
  }
};

if (live) {
  let buffered = '';
  for await (const chunk of process.stdin) {
    buffered += chunk.toString('utf8');
    let at;
    while ((at = buffered.indexOf('\n')) >= 0) {
      const text = textOf(buffered.slice(0, at));
      buffered = buffered.slice(at + 1);
      if (text !== undefined) reply(text);
    }
  }
} else {
  const chunks = [];
  if (!process.stdin.isTTY) for await (const chunk of process.stdin) chunks.push(chunk);
  reply(Buffer.concat(chunks).toString('utf8'));
}
`;

/** Ходы, записанные фальшивым CLI стенда (`bin/turns.jsonl`). */
export function readTurns(readFile, bin) {
  const text = readFile(`${bin}/turns.jsonl`);
  return text
    ? text
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line))
    : [];
}
