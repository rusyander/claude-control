// Продолжение разговора, чей процесс умер с фоновой командой, — на НАСТОЯЩЕМ claude.
//
// Живой прогон 06.10: «Продолжить» трёх групп разделения завело каждой второй чат
// доставки, пока прежний чат продолжал работу в той же копии. Причина — CLI
// (замер 2.1.286): возобновлённая сессия сперва закрывает свой ход уведомления
// пустым `result` с `origin.kind: 'task-notification'`, и лишь потом идёт ход с
// сообщением панели. Панель принимала первый `result` за конец своего хода.
//
// Что исполняется по-настоящему: реестр прогонов панели, живая сессия, посредник,
// сам `claude` (из PATH или `CLAUDE_CLI`) с одноразовым каталогом конфигурации.
// Подменена только модель — заглушкой на 127.0.0.1. Стенд, ~/.claude и чужие
// процессы не трогаются; каталоги удаляются в конце.
//
//   node tools/qa/check-live-resume-ghost.mjs
//
// Код выхода 1 — хоть одна строка таблицы красная.
import { createServer } from 'node:http';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const IS_WIN = process.platform === 'win32';
const seen = [];

/** Текст последнего сообщения пользователя: по нему заглушка выбирает ответ. */
function lastUserText(body) {
  const last = (body.messages ?? []).filter((m) => m.role === 'user').pop();
  if (!last) return '';
  if (typeof last.content === 'string') return last.content;
  return last.content
    .map((b) => (b.type === 'text' ? b.text : b.type === 'tool_result' ? '[tool_result]' : ''))
    .join(' ');
}

function startStub() {
  const server = createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      let body;
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
      } catch {
        body = {};
      }
      if (req.url?.includes('count_tokens')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ input_tokens: 10 }));
        return;
      }
      if (!req.url?.includes('/messages')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{}');
        return;
      }
      const text = lastUserText(body);
      const hasBash = (body.tools ?? []).some((t) => t.name === 'Bash');
      seen.push(text);
      // Первое сообщение — фоновая команда, которая переживёт ход; дальше — эхо метки.
      const block =
        hasBash && /START_BG/.test(text) && !/\[tool_result\]/.test(text)
          ? {
              type: 'tool_use',
              id: 'toolu_bg1',
              name: 'Bash',
              input: {
                command: IS_WIN ? 'ping -n 600 127.0.0.1' : 'sleep 600',
                description: 'background probe',
                run_in_background: true,
              },
            }
          : {
              type: 'text',
              text: /PROMPT_TWO/.test(text)
                ? 'REPLY_TO_PROMPT_TWO'
                : /\[tool_result\]/.test(text)
                  ? 'BG_STARTED'
                  : 'REPLY_OTHER',
            };
      const isText = block.type === 'text';
      const events = [
        [
          'message_start',
          {
            type: 'message_start',
            message: {
              id: `msg_${seen.length}`,
              type: 'message',
              role: 'assistant',
              model: body.model ?? 'stub',
              content: [],
              stop_reason: null,
              usage: { input_tokens: 10, output_tokens: 1 },
            },
          },
        ],
        [
          'content_block_start',
          {
            type: 'content_block_start',
            index: 0,
            content_block: isText ? { type: 'text', text: '' } : { ...block, input: {} },
          },
        ],
        [
          'content_block_delta',
          {
            type: 'content_block_delta',
            index: 0,
            delta: isText
              ? { type: 'text_delta', text: block.text }
              : { type: 'input_json_delta', partial_json: JSON.stringify(block.input) },
          },
        ],
        ['content_block_stop', { type: 'content_block_stop', index: 0 }],
        [
          'message_delta',
          {
            type: 'message_delta',
            delta: { stop_reason: isText ? 'end_turn' : 'tool_use' },
            usage: { output_tokens: 1 },
          },
        ],
        ['message_stop', { type: 'message_stop' }],
      ];
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      for (const [event, data] of events)
        res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      res.end();
    });
  });
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () =>
      resolve({ url: `http://127.0.0.1:${server.address().port}`, close: () => server.close() }),
    ),
  );
}

async function waitFor(check, ms) {
  const until = Date.now() + ms;
  while (!check()) {
    if (Date.now() > until) return false;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return true;
}

const stub = await startStub();
const home = mkdtempSync(join(tmpdir(), 'cc-ghost-home-'));
const work = mkdtempSync(join(tmpdir(), 'cc-ghost-work-'));
writeFileSync(join(work, 'README.md'), 'probe\n');
// Реестр запускает CLI с окружением своего процесса — его и подменяем.
Object.assign(process.env, {
  CLAUDE_CONFIG_DIR: home,
  ANTHROPIC_BASE_URL: stub.url,
  ANTHROPIC_AUTH_TOKEN: 'ghost-stub',
  ANTHROPIC_API_KEY: 'ghost-stub',
  ANTHROPIC_MODEL: 'stub-ghost',
  DISABLE_TELEMETRY: '1',
  DISABLE_AUTOUPDATER: '1',
  DISABLE_ERROR_REPORTING: '1',
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
});

const { ChatRunRegistry } = await import('../../apps/server/src/domains/chat/ChatRunRegistry.ts');
const registry = new ChatRunRegistry();
const finished = [];
registry.setHandoffPlanner((run) => {
  finished.push({ chatId: run.chatId, sessionId: run.sessionId, ok: run.ok, text: run.text });
  return undefined;
});

const base = {
  cwd: work,
  permissionMode: 'bypassPermissions',
  ...(process.env.CLAUDE_CLI ? { command: process.env.CLAUDE_CLI } : {}),
};
const rows = [];
const row = (what, expected, actual, ok) => rows.push({ what, expected, actual, ok });

try {
  // 1. Ход с фоновой командой, затем «Стоп» — процесс умирает вместе с фоном.
  registry.start('new-ghost-1', { ...base, prompt: 'START_BG please' }, {});
  const firstDone = await waitFor(() => finished.length >= 1, 90_000);
  const sessionId =
    registry.describe('new-ghost-1')?.sessionId ?? registry.sessionOf?.('new-ghost-1');
  row(
    'первый ход кончился',
    'BG_STARTED',
    finished[0]?.text ?? '—',
    firstDone && finished[0]?.text === 'BG_STARTED',
  );
  registry.livePool.closeAll();
  registry.stopAll();
  await new Promise((resolve) => setTimeout(resolve, 3000));

  // 2. Продолжение той же сессии одним сообщением.
  const before = finished.length;
  registry.start(
    'new-ghost-2',
    { ...base, prompt: 'PROMPT_TWO continue', sessionId },
    { sessionId },
  );
  await waitFor(() => finished.length > before && !registry.isRunning('new-ghost-2'), 90_000);
  // Пробуждение, если ход ушёл мимо прогона, заводится чуть позже — даём ему время.
  await new Promise((resolve) => setTimeout(resolve, 4000));
  const after = finished.slice(before);
  row('сессия продолжена', 'sessionId есть', sessionId ?? '—', Boolean(sessionId));
  row(
    'ход продолжения закрыт ответом на сообщение',
    'REPLY_TO_PROMPT_TWO',
    after[0]?.text || '(пусто)',
    after[0]?.text === 'REPLY_TO_PROMPT_TWO',
  );
  row('конец хода у планировщика ровно один', '1', String(after.length), after.length === 1);
  row(
    'модель видела сообщение продолжения',
    'да',
    seen.some((t) => /PROMPT_TWO/.test(t)) ? 'да' : 'нет',
    seen.some((t) => /PROMPT_TWO/.test(t)),
  );
} finally {
  registry.livePool.closeAll();
  registry.stopAll();
  stub.close();
  await new Promise((resolve) => setTimeout(resolve, 1500));
  for (const dir of [home, work]) {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    } catch {
      // Папку держит умирающий процесс — останется системе.
    }
  }
}

console.log('| проверка | ожидалось | вышло | итог |\n|---|---|---|---|');
for (const r of rows)
  console.log(`| ${r.what} | ${r.expected} | ${r.actual} | ${r.ok ? 'OK' : 'КРАСНО'} |`);
const red = rows.filter((r) => !r.ok).length;
console.log(red ? `\n${red} красных из ${rows.length}` : `\n${rows.length}/${rows.length} зелёные`);
process.exit(red ? 1 : 0);
