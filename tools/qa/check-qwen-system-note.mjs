/**
 * Строка панели о каталоге проекта у Qwen Code — в СИСТЕМНОМ промпте, а не в
 * словах человека (владелец 11.10). Настоящий `qwen` через настоящую панель.
 *
 * Одноразовый стенд (`throwaway-stand.mjs`), разговор Qwen в каталоге проекта,
 * два вопроса через API панели. Подменена только модель (сетевая граница):
 * заглушка OpenAI chat пишет тела запросов. Свидетель — тело запроса к модели:
 * строка `<agentdeck-workspace>` стоит в сообщении `system` и НИ в одной
 * реплике `user` — ни в новой, ни в повторённой из переписки на втором ходе.
 * Контроль, без которого проверка ничего не доказывает: слова человека дошли до
 * модели (иначе «строки нет в user» верно и для пустого запроса).
 *
 * CLI — из `STEER_CLI_DIR` (каталоги через разделитель PATH), иначе из PATH.
 * Нет CLI — «не проверено», код 2. Дом Qwen — временный; `~/.qwen` и
 * `~/.claude` не трогаются.
 *
 * Запуск: node tools/qa/check-qwen-system-note.mjs
 */
import { createServer } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { NotChecked, startStand, wait } from './throwaway-stand.mjs';

const IS_WIN = process.platform === 'win32';
const TAG = '<agentdeck-workspace>';

function findCli(name) {
  const names = IS_WIN ? [`${name}.cmd`, `${name}.exe`, name] : [name];
  const dirs = [
    ...(process.env.STEER_CLI_DIR ? process.env.STEER_CLI_DIR.split(delimiter) : []),
    ...(process.env.PATH ?? process.env.Path ?? '').split(delimiter),
  ];
  return dirs.find((dir) => dir && names.some((file) => existsSync(join(dir, file))));
}

/** Заглушка OpenAI chat: каждый запрос записан, ответ — одно слово потоком. */
async function startStub() {
  const bodies = [];
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => (raw += chunk));
    req.on('end', () => {
      if (!req.url.includes('chat/completions')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ data: [{ id: 'stub-model', object: 'model' }] }));
        return;
      }
      try {
        bodies.push(JSON.parse(raw || '{}'));
      } catch {
        bodies.push({});
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const chunk = (delta, finish = null) =>
        `data: ${JSON.stringify({
          id: 'c',
          object: 'chat.completion.chunk',
          created: 1,
          model: 'stub-model',
          choices: [{ index: 0, delta, finish_reason: finish }],
        })}\n\n`;
      res.write(chunk({ role: 'assistant', content: 'OK' }));
      res.write(chunk({}, 'stop'));
      res.end('data: [DONE]\n\n');
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    port: server.address().port,
    bodies,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

let failures = 0;
const check = (name, condition, detail = '') => {
  if (condition) console.log(`  ✓ ${name}`);
  else {
    failures += 1;
    console.log(`  ✗ ${name}${detail ? `\n    ${detail}` : ''}`);
  }
  return condition;
};

async function until(probe, seconds) {
  for (let i = 0; i < seconds * 4; i += 1) {
    const value = await probe();
    if (value) return value;
    await wait(250);
  }
  return undefined;
}

const text = (content) =>
  typeof content === 'string'
    ? content
    : Array.isArray(content)
      ? content.map((part) => part?.text ?? '').join(' ')
      : '';
const partsOf = (body, role) =>
  (body?.messages ?? []).filter((message) => message.role === role).map((m) => text(m.content));

console.log('Qwen: строка о каталоге — в системном промпте');
const dir = findCli('qwen');
if (!dir) {
  console.log('  Не проверено: «qwen» нет ни в STEER_CLI_DIR, ни в PATH.');
  process.exit(2);
}

const stub = await startStub();
const root = mkdtempSync(join(tmpdir(), 'cc-qwen-note-'));
const home = join(root, 'qwen-home');
const project = join(root, 'project');
mkdirSync(home, { recursive: true });
mkdirSync(project, { recursive: true });
const added = {
  QWEN_HOME: home,
  OPENAI_BASE_URL: `http://127.0.0.1:${stub.port}/v1`,
  OPENAI_API_KEY: 'x',
  OPENAI_MODEL: 'stub-model',
};
const saved = { PATH: process.env.PATH };
for (const key of Object.keys(added)) saved[key] = process.env[key];
Object.assign(process.env, added, { PATH: `${dir}${delimiter}${process.env.PATH ?? ''}` });

let stand;
let skipped = false;
try {
  stand = await startStand({ web: false, label: 'qwen-note', settings: { provider: 'qwen' } });
  const chat = await stand.api('/provider-chat/chats', {
    method: 'POST',
    body: { workdir: project },
  });
  if (!check('разговор в каталоге проекта создан', chat.status === 200 && chat.body?.id, chat.text))
    throw new Error('no chat');
  const id = chat.body.id;
  const status = async () => (await stand.api(`/provider-chat/chats/${id}/status`)).body;

  for (const [turn, words] of [
    [1, 'FIRST-WORDS-a1'],
    [2, 'SECOND-WORDS-b2'],
  ]) {
    const asked = stub.bodies.length;
    const sent = await stand.api(`/provider-chat/chats/${id}/send`, {
      method: 'POST',
      body: { text: words },
    });
    if (!check(`ход ${turn}: вопрос принят`, sent.status === 200, sent.text)) break;
    const ended = await until(async () => (await status())?.isRunning === false, 120);
    check(`ход ${turn}: ход кончился`, ended, JSON.stringify(await status()));
    const body = stub.bodies
      .slice(asked)
      .find((item) => partsOf(item, 'user').join(' ').includes(words));
    if (
      !check(
        `ход ${turn}: слова человека дошли до модели (контроль)`,
        Boolean(body),
        `запросов этого хода: ${stub.bodies.length - asked}; ${stand.log().slice(-800)}`,
      )
    )
      break;
    const system = partsOf(body, 'system').join('\n');
    const users = partsOf(body, 'user');
    check(`ход ${turn}: строка панели — в system`, system.includes(TAG), system.slice(-400));
    check(
      `ход ${turn}: ни одна реплика user её не несёт`,
      users.every((part) => !part.includes(TAG)),
      users
        .filter((part) => part.includes(TAG))
        .join(' | ')
        .slice(0, 400),
    );
  }

  const messages = (await stand.api(`/provider-chat/chats/${id}`)).body?.messages ?? [];
  check(
    'в переписке — слова человека без строки панели',
    messages.filter((m) => m.role === 'user').every((m) => !m.content.includes(TAG)),
    JSON.stringify(messages.map((m) => m.content)).slice(0, 400),
  );
} catch (error) {
  if (error instanceof NotChecked) {
    skipped = true;
    console.log(`  Не проверено: ${error.message}`);
  } else if (error?.message !== 'no chat') {
    check('сценарий дошёл до конца', false, error?.stack ?? String(error));
  }
} finally {
  if (stand) await stand.stop();
  await wait(500);
  if (stand) rmSync(stand.root, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
  await stub.close();
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
  } catch (error) {
    console.log(`  ! временный каталог не удалён: ${root} (${error.code ?? error.message})`);
  }
}

if (failures > 0) {
  console.log(`\nПровалов: ${failures}`);
  process.exit(1);
}
if (skipped) process.exit(2);
console.log('\nВсё сходится.');
process.exit(0);
