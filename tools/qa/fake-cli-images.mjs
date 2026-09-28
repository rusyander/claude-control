/**
 * Исходник фальшивого CLI для проверок картинок в полях агента
 * (`check-agent-images.mjs`). Стенд кладёт его под именем `claude` (и чужого
 * CLI) первым в PATH панели; скрипт пишет в `calls.jsonl` рядом с собой, что
 * ДОШЛО до процесса — argv, текст и картинки из потокового ввода, — и отвечает
 * в том виде, какой ждёт позвавший: помощник формы — JSON с полями, помощник
 * структуры — JSON с файлами, ассистент шага — блок шага, остальные — текстом.
 *
 * Экспорт — строка: её исходник пишется в файл стенда (`fakeCli`).
 */
export const FAKE_CLI_SOURCE = String.raw`
import { appendFileSync, existsSync } from 'node:fs';
import { basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const argv = process.argv.slice(2);
const self = fileURLToPath(import.meta.url);
const LOG = self.replace(/[^\\/]+$/, 'calls.jsonl');
// Стенд снимает метку перед остановкой: процесс разговора, чей stdin открыт,
// выходит сам и не держит каталог стенда (throwaway-stand.mjs, STAND_ALIVE).
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

const format = after('--output-format');
const out = (event) => process.stdout.write(JSON.stringify(event) + '\n');

/** Записать ход и ответить в том виде, какой ждёт позвавший. */
function answer(text, images) {
  const prompt = argv.join(' ') + '\n' + text;
  appendFileSync(
    LOG,
    JSON.stringify({ cli: basename(self, '.mjs'), argv, text, images, at: Date.now() }) + '\n',
  );
  const count = images.length;
  let reply;
  // Узнаём помощника по началу его строки-заголовка, а не по фразе целиком:
  // формулировку промпта правят (29.09 «…and the kind of value each takes»),
  // и полная фраза молча уводила ход в ветку агента панели.
  if (/Form fields[^\n]*:/.test(prompt)) {
    reply = JSON.stringify({ reply: 'QA-FORM: images=' + count, fields: {} });
  } else if (/The user's (current )?task:/.test(prompt)) {
    reply = JSON.stringify({ reply: 'QA-STRUCTURE: images=' + count, files: [] });
  } else if (prompt.includes(':path-step')) {
    const step = {
      title: { ru: 'QA шаг ' + count, en: 'QA step ' + count },
      prompt: { ru: 'сверить экран', en: 'check the screen' },
    };
    const fence = '\x60\x60\x60';
    reply = 'QA-STEP: images=' + count + '\n\n' + fence + 'agentdeck:path-step\n' +
      JSON.stringify(step) + '\n' + fence + '\n';
  } else {
    reply = 'QA-AGENT: images=' + count;
  }
  if (format === 'stream-json') {
    out({ type: 'system', subtype: 'init', session_id: 'qa-session' });
    out({ type: 'assistant', message: { content: [{ type: 'text', text: reply }] } });
    out({ type: 'result', subtype: 'success', is_error: false, result: reply, session_id: 'qa-session' });
  } else if (format === 'json') {
    process.stdout.write(JSON.stringify({ result: reply, session_id: 'qa-session' }));
  } else {
    process.stdout.write(reply);
  }
}

/** Строка потокового ввода: текст и картинки реплики человека. */
function readLine(line) {
  let text = '';
  const images = [];
  try {
    const event = JSON.parse(line);
    if (event?.type !== 'user') return undefined;
    const content = event?.message?.content;
    if (typeof content === 'string') text = content;
    for (const part of Array.isArray(content) ? content : []) {
      if (part.type === 'text') text += part.text;
      if (part.type === 'image') {
        images.push({ mediaType: part.source?.media_type, data: part.source?.data ?? '' });
      }
    }
  } catch {
    return undefined;
  }
  return { text, images };
}

if (after('--input-format') === 'stream-json') {
  // Отвечаем на каждую строку сразу, не дожидаясь конца ввода: чат держит один
  // процесс на разговор и stdin не закрывает, пока разговор жив.
  let buffered = '';
  for await (const chunk of process.stdin) {
    buffered += chunk.toString('utf8');
    let at;
    while ((at = buffered.indexOf('\n')) >= 0) {
      const line = buffered.slice(0, at);
      buffered = buffered.slice(at + 1);
      const turn = line.trim() ? readLine(line) : undefined;
      if (turn) answer(turn.text, turn.images);
    }
  }
  const tail = buffered.trim() ? readLine(buffered) : undefined;
  if (tail) answer(tail.text, tail.images);
} else {
  const chunks = [];
  if (!process.stdin.isTTY) for await (const chunk of process.stdin) chunks.push(chunk);
  answer(Buffer.concat(chunks).toString('utf8'), []);
}
`;
