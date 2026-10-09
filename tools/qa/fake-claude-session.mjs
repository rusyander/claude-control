/**
 * Исходник фальшивого `claude` с настоящими СЕССИЯМИ — для проверок, где важно,
 * какой разговор панель продолжает (`check-split-recheck-lost-transcript.mjs`,
 * `check-split-delivery-mr-source.mjs`). Стенд кладёт его под именем `claude`
 * первым в PATH панели (`fakeCli`).
 *
 * В главном он ведёт себя как настоящий CLI:
 *  - `--resume <id>` сессии, чьего файла нет в `$CLAUDE_CONFIG_DIR/projects/*`, —
 *    итог-ошибка «No conversation found with session ID: <id>» и код 1;
 *  - без `--resume` — новая сессия, её файл транскрипта ложится в `projects/`;
 *  - каждая реплика человека (потоковый ввод или `-p`) — ход с ответом `reply`,
 *    текст — дельтой `stream_event`, как при `--include-partial-messages`.
 * В `calls.jsonl` рядом с собой пишет, что ДОШЛО до процесса: argv, cwd,
 * `--resume`, сессию, текст реплики.
 *
 * Экспорт — функция от текста ответа: проверке нужен свой ответ (ссылка на MR).
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export function fakeClaudeSession(reply) {
  return String.raw`
import { appendFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const REPLY = ${JSON.stringify(reply)};
const argv = process.argv.slice(2);
const self = fileURLToPath(import.meta.url);
const LOG = self.replace(/[^\\/]+$/, 'calls.jsonl');
const ALIVE = self.replace(/[^\\/]+$/, '.stand-alive');
setInterval(() => {
  if (!existsSync(ALIVE)) process.exit(0);
}, 250).unref();
const after = (flag) => {
  const at = argv.indexOf(flag);
  return at >= 0 ? argv[at + 1] : undefined;
};
if (argv[0] === '--version' || argv[0] === '-v') {
  process.stdout.write('2.1.0 (Claude Code)\n');
  process.exit(0);
}
const out = (event) => process.stdout.write(JSON.stringify(event) + '\n');
const projects = join(process.env.CLAUDE_CONFIG_DIR ?? '', 'projects');
const transcriptOf = (id) =>
  existsSync(projects)
    ? readdirSync(projects)
        .map((dir) => join(projects, dir, id + '.jsonl'))
        .find((file) => existsSync(file))
    : undefined;

const resume = after('--resume');
const call = { argv, cwd: process.cwd(), resume, at: Date.now() };
if (resume && !transcriptOf(resume)) {
  // Так отвечает настоящий CLI на --resume сессии, которой нет на диске.
  appendFileSync(LOG, JSON.stringify({ ...call, outcome: 'no-conversation' }) + '\n');
  out({
    type: 'result',
    subtype: 'error_during_execution',
    is_error: true,
    num_turns: 0,
    errors: ['No conversation found with session ID: ' + resume],
  });
  process.exit(1);
}
const session = resume ?? randomUUID();
const dir = join(projects, process.cwd().replace(/[^a-zA-Z0-9]/g, '-'));
mkdirSync(dir, { recursive: true });
const transcript = join(dir, session + '.jsonl');

function turn(text) {
  appendFileSync(LOG, JSON.stringify({ ...call, session, text, outcome: 'answered' }) + '\n');
  const record = (type, content) =>
    JSON.stringify({ type, sessionId: session, cwd: process.cwd(), message: { role: type, content } });
  appendFileSync(
    transcript,
    record('user', text) + '\n' + record('assistant', [{ type: 'text', text: REPLY }]) + '\n',
  );
  out({ type: 'system', subtype: 'init', session_id: session, cwd: process.cwd() });
  // Текст панель берёт из дельт (--include-partial-messages), как у настоящего
  // CLI; готовое сообщение она читает только ради вызовов инструментов.
  out({
    type: 'stream_event',
    event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: REPLY } },
    session_id: session,
  });
  out({ type: 'assistant', message: { content: [{ type: 'text', text: REPLY }] }, session_id: session });
  out({ type: 'result', subtype: 'success', is_error: false, result: REPLY, session_id: session });
}

function textOf(line) {
  try {
    const event = JSON.parse(line);
    if (event?.type !== 'user') return undefined;
    const content = event.message?.content;
    if (typeof content === 'string') return content;
    return (Array.isArray(content) ? content : [])
      .filter((part) => part.type === 'text')
      .map((part) => part.text)
      .join('');
  } catch {
    return undefined;
  }
}

if (after('--input-format') === 'stream-json') {
  let buffered = '';
  for await (const chunk of process.stdin) {
    buffered += chunk.toString('utf8');
    let at;
    while ((at = buffered.indexOf('\n')) >= 0) {
      const text = textOf(buffered.slice(0, at));
      buffered = buffered.slice(at + 1);
      if (text !== undefined) turn(text);
    }
  }
} else {
  turn(after('-p') ?? after('--print') ?? argv.at(-1) ?? '');
}
`;
}

/** Строки `calls.jsonl` фальшивого CLI в каталоге `bin` стенда. */
export function readCalls(bin) {
  const file = join(bin, 'calls.jsonl');
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}
