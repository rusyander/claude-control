/**
 * Исходник фальшивого CLI для помощника форм (`check-assistant-fields.mjs`).
 * Стенд кладёт его под именем `claude` первым в PATH одноразовой панели.
 *
 * Что делает: читает задание помощника из stdin (так его шлёт
 * `runClaudeOneShot` сервера), дописывает его в `prompts.jsonl` рядом с собой
 * вместе со своим argv и рабочим каталогом — проверка по нему видит, какие
 * допустимые значения ДОШЛИ до модели, с какими флагами запущен CLI (лёгкое
 * окно: без инструментов, сессии и наших слоёв) и не дошёл ли до неё секрет, —
 * и отвечает конвертом `--output-format json` с полями из
 * `assistant-answers.json` (ключ — `kind` формы). Ответы кладёт проверка, когда
 * знает id засеянных сущностей: так помощник «выбирает» ровно то, что есть на
 * стенде, плюс заведомо несуществующее — его форма обязана отбросить и назвать.
 *
 * Ответ формы — либо объект полей (один на любую просьбу), либо список
 * `[{ when, reply?, fields }]`: берётся первый, чья подстрока `when` есть в
 * ТЕКУЩЕЙ просьбе (строка `The user's current request:`), а последний без
 * `when` — запасной. Так один прогон ведёт по форме несколько ходов:
 * «заполни», «только предложи», «поменяй одно». Задание помощника структуры —
 * вид `structure`, и ответ несёт `files` (путь + содержимое), а не поля.
 *
 * Экспорт — строка: её исходник пишется в файл стенда (`fakeCli`).
 */
export const FAKE_ASSISTANT_CLI_SOURCE = String.raw`
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const argv = process.argv.slice(2);
const self = fileURLToPath(import.meta.url);
const near = (name) => self.replace(/[^\\/]+$/, name);

if (argv[0] === '--version' || argv[0] === '-v') {
  process.stdout.write('2.1.0 (Claude Code)\n');
  process.exit(0);
}

let prompt = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => (prompt += chunk));
process.stdin.on('end', () => {
  // Помощник структуры — свой вид задания; отвечает файлами, а не полями.
  const kind = prompt.startsWith('You help build the structure')
    ? 'structure'
    : (/fill in the form "([^"]+)"/.exec(prompt)?.[1] ?? '');
  // Прежняя форма задания звала строку просьбы без «current» — прогон «до правки» тоже ходит по ходам.
  const request = /The user's (?:current )?(?:request|task): (.*)/.exec(prompt)?.[1] ?? '';
  appendFileSync(
    near('prompts.jsonl'),
    JSON.stringify({ kind, request, prompt, argv, cwd: process.cwd(), at: Date.now() }) + '\n',
  );
  const file = near('assistant-answers.json');
  const answers = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
  const entry = answers[kind] ?? {};
  const scripted = Array.isArray(entry)
    ? (entry.find((item) => item.when && request.includes(item.when)) ??
      entry.find((item) => !item.when) ?? { fields: {} })
    : { fields: entry };
  const reply = JSON.stringify({
    reply: scripted.reply ?? 'QA-REPLY ' + kind,
    fields: scripted.fields ?? {},
    ...(scripted.files ? { files: scripted.files } : {}),
  });
  process.stdout.write(JSON.stringify({ result: reply, session_id: 'qa-assistant' }));
});
`;
