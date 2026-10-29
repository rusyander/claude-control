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
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startStubModel } from '../../packages/stub-model/src/index.mjs';

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

async function startStub() {
  const stub = await startStubModel({
    // Вне `/messages` (служебные пути CLI) — пустой JSON, как было у своего стаба.
    route: ({ path }) => (path.includes('/messages') ? undefined : { body: {} }),
    script: ({ request }) => {
      const text = lastUserText(request.body);
      seen.push(text);
      // Первое сообщение — фоновая команда, которая переживёт ход; дальше — эхо метки.
      if (
        request.tools.includes('Bash') &&
        /START_BG/.test(text) &&
        !/\[tool_result\]/.test(text)
      ) {
        const args = {
          command: IS_WIN ? 'ping -n 600 127.0.0.1' : 'sleep 600',
          description: 'background probe',
          run_in_background: true,
        };
        return { tool: { name: 'Bash', args, id: 'toolu_bg1' } };
      }
      if (/PROMPT_TWO/.test(text)) return 'REPLY_TO_PROMPT_TWO';
      return /\[tool_result\]/.test(text) ? 'BG_STARTED' : 'REPLY_OTHER';
    },
  });
  return { url: stub.baseUrl, close: () => stub.close() };
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

const { ChatRunRegistry } =
  await import('../../apps/server/src/domains/chat/ChatRunRegistry/ChatRunRegistry.ts');
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
