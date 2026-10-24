/**
 * Сторож одиночных чатов и новые правила R22–R31 на одноразовой панели — весь
 * путь: поток прогона → реестр → сторож → срез сигналов → `GET
 * /api/chat/watch-signals` (одиночный чат) и `GET /api/chat/<родитель>/tree`
 * (группа), и сообщение в Telegram.
 *
 * Подменены только внешние края: модель (фальшивый `claude` на PATH проигрывает
 * поток stream-json), сервер Telegram (заглушка по `AGENTDECK_TELEGRAM_API`) и
 * часы панели (`NODE_OPTIONS --import` сдвигает `Date` на число из файла).
 * Часы двигаются потому, что пороги в минутах: тревога вопроса — не раньше 15
 * мин (`askAlertMinutes` ≥ 15), а тик сторожа — раз в 60 с и не настраивается
 * (`WATCH_TICK_MS`). Сдвиг часов не ускоряет тик: проверка ждёт настоящий тик.
 *
 * Одиночный чат (связи с деревом нет, автономия включена), один ход:
 *   - трижды один и тот же упавший скрипт → R24 (fails 3, call, голова ошибки);
 *   - netstat по портам, затем цикл taskkill по PID и сон ПОСЛЕ цикла → R26, R11 нет;
 *   - `git push` отбит правом, затем `git -c … push` прошёл → R25 «тревога»;
 *   - два вызова несуществующего инструмента («No such tool available») → R29;
 *   - три повтора запроса к модели (`system/api_retry`, 529) → R30 service model;
 *   - правка вне каталога чата → R31 НЕТ (правило только для групп);
 *   - ход кончился вопросом текстом → R27 через минуту, «тревога» через 15.
 * Группа разделения: звено правит файл вне своей копии (R31) и кончает ход с
 * открытым AskUserQuestion (R1b: «внимание» через минуту, «тревога» через 15);
 * вторая группа `started` без единого прогона 45 мин → R22 why=no-run, после
 * сдвига часов — «тревога».
 * Telegram: «внимание» группы уходит по разу, одиночный чат — только «тревога»
 * (R25, затем R27), рост до «тревоги» шлёт второе сообщение (R1b, R22).
 *
 * `QA_CHAT_WATCH_SINGLE_OFF=1` — тот же прогон с `groupWatch.singleChats=false`:
 * проверка обязана покраснеть (сигналов чата нет), это её проверка на пустоту.
 *
 * Запуск: node tools/qa/check-chat-watch.mjs   (только API, браузер не нужен; ~3 мин)
 */
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { basename, join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { freePort, runOnStand, wait } from './throwaway-stand.mjs';

const PARENT = 'qa-cw-parent';
/** Звено группы 0 — разговор, который продолжает прогон. */
const GROUP_SESSION = '5e551000-0000-4000-8000-0000000000a1';
/** Группа 1: чат заведён, первого хода не было — ключ временный. */
const IDLE_KEY = `new-${Date.now()}-2`;
/** Одиночный чат: своя сессия, связи с деревом нет. */
const SOLO = '5e551000-0000-4000-8000-0000000000b2';
const COPY_NAME = 'qa-cw-app';
const SOLO_NAME = 'qa-cw-solo';
const SEED = 'node scripts/seed.mjs';
const PUSH = 'git push origin feature/ports';
const PUSH_AROUND = 'git -c core.hooksPath=/dev/null push origin feature/ports';
const MISSING_TOOL = 'mcp__tracker__create_issue';
const QUESTION = 'Стенд перезапущен. Какой порт оставить за ним — 5173 или 5174?';
const ASK = 'Какую ветку брать за основу — main или release?';
/** Путь вне копии и вне временного каталога: каталог temp сторож законно пропускает. */
const OUTSIDE =
  process.platform === 'win32'
    ? 'C:/projects/main-app/src/config.ts'
    : '/srv/main-app/src/config.ts';
const SINGLE_OFF = process.env.QA_CHAT_WATCH_SINGLE_OFF === '1';

/** Фальшивый `claude`: ход по метке в реплике проигрывает поток stream-json CLI 2.1.x. */
const FAKE_CLAUDE = String.raw`
import { appendFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const argv = process.argv.slice(2);
const self = fileURLToPath(import.meta.url);
const LOG = self.replace(/[^\\/]+$/, 'calls.jsonl');
const ALIVE = self.replace(/[^\\/]+$/, '.stand-alive');
setInterval(() => { if (!existsSync(ALIVE)) process.exit(0); }, 250).unref();
if (argv[0] === '--version' || argv[0] === '-v') {
  process.stdout.write('2.1.0 (Claude Code)\n');
  process.exit(0);
}
const after = (flag) => { const at = argv.indexOf(flag); return at >= 0 ? argv[at + 1] : undefined; };
const session = after('--resume') ?? after('--session-id') ?? 'qa-no-session';
const out = (event) => process.stdout.write(JSON.stringify({ ...event, session_id: session }) + '\n');
let n = 0;
// more: isError — блок ошибки; line(id) — верхние поля строки результата (tool_result_meta CLI 2.1.286);
// open — вызов без ответа (вопрос ждёт человека).
const tool = (name, input, result, more = {}) => {
  n += 1;
  const id = 'toolu_qa_' + n;
  out({ type: 'assistant', message: { id: 'msg_qa_' + n, role: 'assistant', model: 'claude-opus-5', content: [{ type: 'tool_use', id, name, input }] } });
  if (more.open) return;
  out({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: result, ...(more.isError ? { is_error: true } : {}) }] }, ...(more.line ? more.line(id) : {}) });
};

function turn(text) {
  appendFileSync(LOG, JSON.stringify({ cwd: process.cwd(), session, text: text.slice(0, 200), at: Date.now() }) + '\n');
  out({ type: 'system', subtype: 'init', cwd: process.cwd(), model: 'claude-opus-5', tools: [] });
  let reply = 'Done.';
  if (text.includes('QA_SOLO_1')) {
    // R31 — правило группы: в одиночном чате правка где угодно законна. До серии R24:
    // правка между падениями — уже другая попытка, серия с неё начинается заново.
    tool('Edit', { file_path: ${JSON.stringify(OUTSIDE)}, old_string: 'port: 5173', new_string: 'port: 5174' }, 'ok');
    // R24: тот же скрипт трижды той же ошибкой, правок между ними нет.
    for (let i = 0; i < 3; i++) {
      tool('Bash', { command: ${JSON.stringify(SEED)} }, 'Exit code 1\nError: Cannot find module ./fixtures/seed-data.json', { isError: true });
    }
    // R26: PID из поиска по портам — в следующем вызове; сон после цикла, не в нём (не R11).
    tool('Bash', { command: 'netstat -ano | grep -E ":(5173|5174) .*LISTENING"' },
      '  TCP    127.0.0.1:5173    0.0.0.0:0    LISTENING    31480\n  TCP    127.0.0.1:5174    0.0.0.0:0    LISTENING    91604');
    tool('Bash', { command: 'for p in 31480 91604; do taskkill //PID $p //T //F 2>&1 | head -1; done; sleep 1' },
      'SUCCESS: The process with PID 31480 has been terminated.');
    // R25: пуш отбит правом, тот же пуш — другой командой.
    const denied = 'Permission for this action was denied by the rule Bash(git push:*).';
    tool('Bash', { command: ${JSON.stringify(PUSH)} }, denied, {
      isError: true,
      line: (id) => ({ tool_use_result: 'Error: ' + denied, tool_result_meta: [{ id, non_execution_kind: 'permission-rule' }] }),
    });
    tool('Bash', { command: ${JSON.stringify(PUSH_AROUND)} }, 'To tracker.example.com:team/app.git\n   1a2b3c4..5d6e7f8  feature/ports -> feature/ports');
    // R29: инструмента нет в сессии — настоящая формулировка CLI.
    for (let i = 0; i < 2; i++) {
      tool(${JSON.stringify(MISSING_TOOL)}, { title: 'PROJ-7 порты стенда' },
        '<tool_use_error>Error: No such tool available: ${MISSING_TOOL}</tool_use_error>', { isError: true });
    }
    // R30: повторы запроса к модели после сбоя сервиса.
    for (let attempt = 1; attempt <= 3; attempt++) {
      out({ type: 'system', subtype: 'api_retry', attempt, max_retries: 10, retry_delay_ms: 500, error_status: 529, error: 'overloaded_error' });
    }
    reply =${JSON.stringify(QUESTION)};
  }
  if (text.includes('QA_GROUP_1')) {
    // R31: правка вне своей копии.
    tool('Edit', { file_path: ${JSON.stringify(OUTSIDE)}, old_string: 'a', new_string: 'b' }, 'ok');
    // R1b: вопрос карточкой остаётся без ответа — ход кончается, вопрос висит.
    tool('AskUserQuestion', {
      questions: [{ question: ${JSON.stringify(ASK)}, header: 'Ветка', multiSelect: false,
        options: [{ label: 'main', description: 'основная' }, { label: 'release', description: 'ветка выпуска' }] }],
    }, '', { open: true });
  }
  out({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: reply } } });
  out({ type: 'assistant', message: { id: 'msg_qa_text_' + n, role: 'assistant', model: 'claude-opus-5', content: [{ type: 'text', text: reply }] } });
  out({ type: 'result', subtype: 'success', is_error: false, result: reply, num_turns: 1 });
}

function textOf(line) {
  try {
    const event = JSON.parse(line);
    if (event?.type !== 'user') return undefined;
    const content = event.message?.content;
    if (typeof content === 'string') return content;
    return (Array.isArray(content) ? content : []).filter((p) => p.type === 'text').map((p) => p.text).join('');
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

/**
 * Часы панели: `Date` со сдвигом из файла (мс). Файл перечитывается раз в 100 мс,
 * так что прогон двигает время панели, не перезапуская её. Экземпляры — настоящий
 * `Date` (instanceof, методы, `mtime` файлов сходятся).
 */
const CLOCK = String.raw`
import { readFileSync } from 'node:fs';
const file = process.env.QA_CLOCK_FILE;
if (file) {
  const RealDate = Date;
  let offset = 0;
  const read = () => {
    try { offset = Number(readFileSync(file, 'utf8')) || 0; } catch { offset = 0; }
  };
  read();
  setInterval(read, 100).unref();
  function ShiftedDate(...args) {
    if (!new.target) return new RealDate(RealDate.now() + offset).toString();
    return args.length === 0 ? new RealDate(RealDate.now() + offset) : new RealDate(...args);
  }
  ShiftedDate.prototype = RealDate.prototype;
  ShiftedDate.now = () => RealDate.now() + offset;
  ShiftedDate.parse = RealDate.parse;
  ShiftedDate.UTC = RealDate.UTC;
  Object.defineProperty(ShiftedDate, Symbol.hasInstance, { value: (v) => v instanceof RealDate });
  globalThis.Date = ShiftedDate;
}
`;

// ---- часы и заглушка Telegram -------------------------------------------------------------------
const clockDir = mkdtempSync(join(tmpdir(), 'cc-chat-watch-clock-'));
const clockFile = join(clockDir, 'offset');
const clockModule = join(clockDir, 'clock.mjs');
writeFileSync(clockFile, '0');
writeFileSync(clockModule, CLOCK);
// Итог проверки — `process.exit` внутри `runOnStand`: `finally` ниже до него не доходит.
process.on('exit', () => rmSync(clockDir, { recursive: true, force: true }));
/** Сдвинуть часы панели на `minutes` от настоящего времени и дождаться, пока она перечитает файл. */
const shiftClock = async (minutes) => {
  writeFileSync(clockFile, String(minutes * 60_000));
  await wait(400);
};

const telegram = [];
const tgPort = await freePort();
const tg = createServer((req, res) => {
  const chunks = [];
  req.on('data', (chunk) => chunks.push(chunk));
  req.on('end', () => {
    let body = {};
    try {
      body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
      // пустое тело — тоже запрос
    }
    telegram.push({ path: req.url ?? '', body });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"ok":true,"result":{}}');
  });
});
await new Promise((done) => tg.listen(tgPort, '127.0.0.1', done));

let copy = '';
let solo = '';
const transcriptLine = (session, cwd, type, content) =>
  JSON.stringify({ type, sessionId: session, cwd, message: { role: type, content } });
/** Репозиторий с одним коммитом и транскрипт сессии: прогон её продолжает. */
const seedRepo = (cfg, dir, branch, session, title) => {
  mkdirSync(join(dir, 'src'), { recursive: true });
  writeFileSync(join(dir, 'src', 'app.ts'), 'export const port = 5173;\n');
  const git = (...args) => execFileSync('git', args, { cwd: dir, stdio: 'pipe' });
  git('init', '-q', '-b', branch);
  git('add', '.');
  git('-c', 'user.name=qa', '-c', 'user.email=qa@example.com', 'commit', '-q', '-m', 'init');
  const transcripts = join(cfg, 'projects', dir.replace(/[^a-zA-Z0-9]/g, '-'));
  mkdirSync(transcripts, { recursive: true });
  writeFileSync(
    join(transcripts, `${session}.jsonl`),
    `${transcriptLine(session, dir, 'user', title)}\n${transcriptLine(session, dir, 'assistant', [{ type: 'text', text: 'Начинаю.' }])}\n`,
  );
};

try {
  await runOnStand(
    {
      label: 'chat-watch',
      web: false,
      fakeCli: { claude: FAKE_CLAUDE },
      env: {
        AGENTDECK_TELEGRAM_API: `http://127.0.0.1:${tgPort}`,
        NODE_OPTIONS: `--import=${pathToFileURL(clockModule).href}`,
        QA_CLOCK_FILE: clockFile,
      },
      seed: ({ root, cfg }) => {
        copy = join(root, COPY_NAME);
        solo = join(root, SOLO_NAME);
        seedRepo(cfg, copy, 'feature/ports', GROUP_SESSION, 'PROJ-7 Порты стенда');
        seedRepo(cfg, solo, 'main', SOLO, 'Подними стенд');
        const ago = (min) => new Date(Date.now() - min * 60_000).toISOString();
        const plan = {
          parentChatId: PARENT,
          projectPath: copy,
          createdAt: ago(50),
          order: [0, 1],
          request: {},
          proposal: {
            groups: [
              { title: 'Порты', branch: 'feature/ports', tasks: ['PROJ-7 Порты стенда'] },
              { title: 'Справка', branch: 'feature/help', tasks: ['PROJ-8 Справка'] },
            ],
          },
          groups: [
            {
              index: 0,
              title: 'Порты',
              branch: 'feature/ports',
              after: [],
              status: 'started',
              chatId: GROUP_SESSION,
              path: copy,
              startedAt: ago(3),
            },
            // Стоит: начата 45 мин назад, ни одного прогона, вопроса и очереди нет (R22).
            {
              index: 1,
              title: 'Справка',
              branch: 'feature/help',
              after: [],
              status: 'started',
              chatId: IDLE_KEY,
              path: copy,
              startedAt: ago(45),
            },
          ],
        };
        const link = (groupIndex, title, branch, conversation) => ({
          parentChatId: PARENT,
          title,
          branch,
          groupIndex,
          stage: 'work',
          conversation,
          createdAt: ago(50),
        });
        const file = join(cfg, 'agentdeck', 'state.json');
        const state = JSON.parse(readFileSync(file, 'utf8'));
        writeFileSync(
          file,
          `${JSON.stringify({
            ...state,
            splitPlans: { [PARENT]: plan },
            chatLinks: {
              [GROUP_SESSION]: link(0, 'Порты', 'feature/ports', GROUP_SESSION),
              [IDLE_KEY]: link(1, 'Справка', 'feature/help', IDLE_KEY),
            },
          })}\n`,
        );
      },
    },
    async (stand, check) => {
      const calls = () => {
        const file = join(stand.bin, 'calls.jsonl');
        return existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean) : [];
      };
      const active = (list, rule) => list.find((one) => one.rule === rule && !one.clearedAt);
      /** Сигналы одиночного чата — из ответа маршрута, который читает веб. */
      const chatSignals = async () => {
        const res = await stand.api('/chat/watch-signals');
        const all = res.body?.signals ?? {};
        return { status: res.status, all, list: [...(all[SOLO] ?? [])] };
      };
      const groupSignals = async (index) =>
        (await stand.api(`/chat/${PARENT}/tree`)).body?.split?.groups?.[index]?.watchSignals ?? [];
      /** Почему сигнала нет: статус группы на записи и ходы, которые отыграл фальшивый CLI. */
      const groupState = async (index) => {
        const tree = (await stand.api(`/chat/${PARENT}/tree`)).body;
        const g = tree?.split?.groups?.[index] ?? {};
        return JSON.stringify({
          status: g.status,
          waitingFor: g.waitingFor,
          interruptedAt: g.interruptedAt,
          asks: tree?.asks ?? tree?.pendingAsks,
          rules: (g.watchSignals ?? []).map((s) => s.rule),
          calls: calls().map((line) => JSON.parse(line).text.slice(0, 40)),
        });
      };
      const until = async (ms, probe) => {
        for (let t = 0; t < ms; t += 500) {
          if (await probe()) return true;
          await wait(500);
        }
        return false;
      };
      const texts = () => telegram.map((one) => String(one.body?.text ?? ''));
      const sent = (rule) => texts().filter((text) => text.includes(` ${rule} `));
      const show = (signal) =>
        signal
          ? JSON.stringify({
              rule: signal.rule,
              severity: signal.severity,
              numbers: signal.numbers,
              params: signal.params,
              chatId: signal.chatId,
              groupIndex: signal.groupIndex,
            })
          : 'сигнала нет';

      // ------------------------------------------------------------ настройки
      const defaults = (await stand.api('/settings')).body?.groupWatch ?? {};
      check(
        'заводская настройка: одиночные чаты под сторожем (singleChats=true)',
        defaults.singleChats === true,
        JSON.stringify({ singleChats: defaults.singleChats }),
      );
      // Пороги в минутах — у нижних границ схемы, чтобы прогон шёл минуты, а не час.
      const patched = await stand.api('/settings', {
        method: 'PATCH',
        body: {
          groupWatch: {
            askMinutes: 1,
            askAlertMinutes: 15,
            proseWaitMinutes: 1,
            ...(SINGLE_OFF ? { singleChats: false } : {}),
          },
        },
      });
      check(
        `пороги вопроса сняты до минуты через PATCH${SINGLE_OFF ? ' (singleChats=false)' : ''}`,
        patched.status === 200,
        patched.text.slice(0, 200),
      );
      const tgSaved = await stand.api('/integrations/telegram', {
        method: 'PUT',
        body: {
          settings: { enabled: true, chatId: '@qa-chat-watch', events: ['groupSignal'] },
          token: '123:qa',
        },
      });
      check('Telegram включён, подписка — сигналы сторожа', tgSaved.status === 200, tgSaved.text);
      const autonomy = await stand.api(`/chat/${SOLO}/group-settings`, {
        method: 'PUT',
        body: { autonomous: true },
      });
      check(
        'одиночный чат автономен (вопрос текстом подхватить некому)',
        autonomy.status === 200 && autonomy.body?.autonomous === true,
        autonomy.text.slice(0, 200),
      );

      // ------------------------------------------------------- одиночный чат
      const soloSent = await stand.api('/chat/send', {
        method: 'POST',
        body: {
          chatId: SOLO,
          sessionId: SOLO,
          prompt: 'QA_SOLO_1 подними стенд',
          projectPath: solo,
        },
      });
      check('ход одиночного чата принят', soloSent.status === 200, soloSent.text.slice(0, 300));
      let chat = { status: 0, all: {}, list: [] };
      await until(30_000, async () => {
        chat = await chatSignals();
        return (
          calls().length >= 1 &&
          ['R24', 'R25', 'R26', 'R29', 'R30'].every((r) => active(chat.list, r))
        );
      });
      check('фальшивый CLI отыграл ход чата', calls().length >= 1, String(calls().length));
      check(
        'GET /api/chat/watch-signals отвечает 200, сигналы — под id чата без связи',
        chat.status === 200 && chat.list.length > 0,
        JSON.stringify(Object.keys(chat.all)),
      );
      const r24 = active(chat.list, 'R24');
      check(
        'R24: тот же скрипт трижды той же ошибкой — «внимание», fails 3, вызов и голова ошибки',
        r24?.severity === 'warn' &&
          r24.numbers?.fails === 3 &&
          r24.params?.call === SEED &&
          String(r24.params?.error ?? '').includes('Cannot find module') &&
          r24.groupIndex === -1,
        show(r24),
      );
      const r26 = active(chat.list, 'R26');
      check(
        'R26: taskkill по PID из поиска портов — «внимание», цель называет PID',
        r26?.severity === 'warn' &&
          r26.numbers?.kills >= 1 &&
          /PID/.test(String(r26.params?.target)),
        show(r26),
      );
      check(
        'R11 нет: сон после цикла остановки — не опрос',
        !active(chat.list, 'R11'),
        show(active(chat.list, 'R11')),
      );
      const r25 = active(chat.list, 'R25');
      check(
        'R25: отбитый пуш сделан другой командой — «тревога», op push, команда обхода',
        r25?.severity === 'alert' &&
          r25.params?.op === 'push' &&
          r25.params?.command === PUSH_AROUND,
        show(r25),
      );
      const r29 = active(chat.list, 'R29');
      check(
        'R29: два вызова инструмента, которого нет, — calls 2, имя инструмента',
        r29?.numbers?.calls === 2 && r29.params?.tool === MISSING_TOOL,
        show(r29),
      );
      const r30 = active(chat.list, 'R30');
      check(
        'R30: три повтора запроса к модели (api_retry 529) — failures 3, service model',
        r30?.numbers?.failures === 3 && r30.params?.service === 'model',
        show(r30),
      );
      check(
        'R31 нет в одиночном чате: правка вне каталога — не его правило',
        !active(chat.list, 'R31'),
        show(active(chat.list, 'R31')),
      );
      check(
        'R27 ещё нет: вопрос текстом ждёт меньше proseWaitMinutes',
        !active(chat.list, 'R27'),
        show(active(chat.list, 'R27')),
      );
      const tree0 = await groupSignals(0);
      check(
        'сигналы чата не легли на запись группы',
        !tree0.some((signal) => signal.chatId === SOLO),
        JSON.stringify(tree0.map((s) => [s.rule, s.chatId])),
      );

      // ------------------------------------------------------------- группа
      // Вопрос группы «по плану» панель закрывает сама (group-wait.ts) — тогда ждать нечего,
      // и R1b законно молчит. Автономия, выключенная в самом чате звена, план перебивает.
      const groupManual = await stand.api(`/chat/${GROUP_SESSION}/group-settings`, {
        method: 'PUT',
        body: { autonomous: false },
      });
      check(
        'звено группы без автономии (вопрос ждёт человека, панель за него не отвечает)',
        groupManual.status === 200 && groupManual.body?.autonomous === false,
        groupManual.text.slice(0, 200),
      );
      const groupSent = await stand.api('/chat/send', {
        method: 'POST',
        body: {
          chatId: GROUP_SESSION,
          sessionId: GROUP_SESSION,
          prompt: 'QA_GROUP_1 продолжай работу группы',
          projectPath: copy,
        },
      });
      check('ход звена группы принят', groupSent.status === 200, groupSent.text.slice(0, 300));
      let group0 = [];
      await until(30_000, async () => {
        group0 = await groupSignals(0);
        return calls().length >= 2 && Boolean(active(group0, 'R31'));
      });
      const r31 = active(group0, 'R31');
      check(
        'R31: звено правит файл вне своей копии — «внимание» на записи группы, путь',
        r31?.severity === 'warn' && r31.numbers?.writes === 1 && r31.params?.path === OUTSIDE,
        show(r31) ?? JSON.stringify(group0.map((s) => s.rule)),
      );
      check(
        'R1b ещё нет: вопрос висит меньше askMinutes',
        !active(group0, 'R1b'),
        show(active(group0, 'R1b')),
      );

      // ---------------------------------------------- тик: +2 мин на часах панели
      await shiftClock(2);
      let group1 = [];
      const ticked = await until(80_000, async () => {
        chat = await chatSignals();
        group0 = await groupSignals(0);
        group1 = await groupSignals(1);
        return Boolean(active(chat.list, 'R27') && active(group0, 'R1b') && active(group1, 'R22'));
      });
      check('тик сторожа прошёл (≤ 80 с после сдвига часов)', ticked, '');
      const r27 = active(chat.list, 'R27');
      check(
        'R27: ход чата кончился вопросом текстом — «внимание», ждёт ≥ 2 мин, вопрос в подстановке',
        r27?.severity === 'warn' && r27.numbers?.waitMin >= 2 && r27.params?.question === QUESTION,
        show(r27),
      );
      const r1b = active(group0, 'R1b');
      check(
        'R1b: вопрос карточкой ждёт ≥ 2 мин — «внимание» с вопросом',
        r1b?.severity === 'warn' &&
          r1b.numbers?.waitMin >= 2 &&
          String(r1b.params?.question).includes('Какую ветку'),
        r1b ? show(r1b) : await groupState(0),
      );
      const r22 = active(group1, 'R22');
      // Панель поднялась, а группа «started» без процесса: разбор при запуске помечает её
      // прерванной (recoverInterruptedGroups → interruptedAt) — причина строки «restart».
      const idle1 = (await stand.api(`/chat/${PARENT}/tree`)).body?.split?.groups?.[1] ?? {};
      check(
        'R22: группа без прогона 45+ мин после запуска панели — «внимание», why restart',
        r22?.severity === 'warn' &&
          r22.numbers?.idleMin >= 45 &&
          r22.params?.why === 'restart' &&
          Boolean(idle1.interruptedAt),
        `${show(r22)} interruptedAt=${idle1.interruptedAt}`,
      );
      check(
        'R22 нет у группы с висящим вопросом (вопрос — законное ожидание)',
        !active(group0, 'R22'),
        show(active(group0, 'R22')),
      );

      // -------------------------------------- тик: +17 мин — вопросы до «тревоги»
      await shiftClock(17);
      const escalated = await until(80_000, async () => {
        chat = await chatSignals();
        group0 = await groupSignals(0);
        group1 = await groupSignals(1);
        return (
          active(chat.list, 'R27')?.severity === 'alert' &&
          active(group0, 'R1b')?.severity === 'alert' &&
          active(group1, 'R22')?.severity === 'alert'
        );
      });
      check('следующий тик поднял важность (≤ 80 с)', escalated, '');
      check(
        'R27 → «тревога» через askAlertMinutes, сигнал тот же',
        active(chat.list, 'R27')?.severity === 'alert' &&
          chat.list.filter((s) => s.rule === 'R27').length === 1,
        JSON.stringify(chat.list.filter((s) => s.rule === 'R27').map(show)),
      );
      check(
        'R1b → «тревога», ждёт ≥ 17 мин',
        active(group0, 'R1b')?.severity === 'alert' && active(group0, 'R1b').numbers?.waitMin >= 17,
        show(active(group0, 'R1b')),
      );
      check(
        'R22 → «тревога» втрое дольше порога (idle ≥ 60)',
        active(group1, 'R22')?.severity === 'alert' && active(group1, 'R22').numbers?.idleMin >= 60,
        show(active(group1, 'R22')),
      );

      // ------------------------------------------------------------- Telegram
      // Отправка асинхронна: лишняя пришла бы чуть позже.
      await wait(2_500);
      console.log(`     Telegram: ${telegram.length} сообщ.\n       ${texts().join('\n       ')}`);
      const single = (rule, icon) => sent(rule).length === 1 && sent(rule)[0].startsWith(icon);
      check(
        'одиночный чат: «внимание» наружу не уходит (R24, R26, R29, R30 — 0 сообщений)',
        ['R24', 'R26', 'R29', 'R30'].every((rule) => sent(rule).length === 0),
        texts().join(' | '),
      );
      check(
        'одиночный чат: R25 «тревога» — одно сообщение ⛔ с заголовком и «после отказа», проект чата',
        single('R25', '⛔') &&
          sent('R25')[0].includes('отбитое действие сделано другим путём') &&
          sent('R25')[0].includes('мин после отказа') &&
          sent('R25')[0].endsWith(`— ${SOLO_NAME}`),
        sent('R25').join(' | '),
      );
      check(
        'одиночный чат: R27 уходит один раз — когда стал «тревогой»',
        single('R27', '⛔') && sent('R27')[0].includes('вопрос текстом ждёт ответа'),
        sent('R27').join(' | '),
      );
      check(
        'группа: R31 «внимание» — одно сообщение ⚠️ с заголовком и проектом копии',
        single('R31', '⚠️') &&
          sent('R31')[0].includes('правки вне своей копии') &&
          sent('R31')[0].endsWith(`— ${basename(copy)}`),
        sent('R31').join(' | '),
      );
      const twice = (rule) =>
        sent(rule).length === 2 && sent(rule)[0].startsWith('⚠️') && sent(rule)[1].startsWith('⛔');
      check(
        'R1b: рост до «тревоги» — второе сообщение (⚠️, затем ⛔) внутри срока тишины',
        twice('R1b'),
        sent('R1b').join(' | '),
      );
      check(
        'R22: рост до «тревоги» — второе сообщение (⚠️, затем ⛔), заголовок «группа стоит без хода»',
        twice('R22') && sent('R22').every((text) => text.includes('группа стоит без хода')),
        sent('R22').join(' | '),
      );
      check(
        'всего сообщений ровно 7 (R25, R27, R31, R1b×2, R22×2) и все — адресату через бота заглушки',
        telegram.length === 7 &&
          telegram.every(
            (one) =>
              one.body?.chat_id === '@qa-chat-watch' &&
              one.path.startsWith('/bot123:qa/sendMessage'),
          ),
        String(telegram.length),
      );
    },
  );
} finally {
  tg.close();
}
