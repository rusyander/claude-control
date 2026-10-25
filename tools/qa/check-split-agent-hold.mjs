/**
 * Живое доказательство исключения в `SPLIT_FOREGROUND_PROMPT`: фоновый подагент
 * группы — законный конец хода, а не «результат группы».
 *
 * Строка переднего плана теперь велит группе с фоновыми подагентами КОНЧИТЬ ход
 * (журнал группы 1, 23.10: два цикла `sleep` над файлами дорожек держали ход
 * 698 + 722 с). Это верно, только если панель на самом деле держит группу, пока
 * подагент идёт, и будит её его возвратом. Юнит-тест видит фразу в дописке;
 * вопрос — что сделают с ней настоящий CLI и настоящая сессия панели.
 *
 * Подменена одна модель: стаб вместо API Anthropic. Ход 1 зовёт Agent с
 * `run_in_background: true`, после «Async agent launched» кончает ход строкой;
 * подагент отвечает с задержкой; ход пробуждения отвечает словом WAKE_WORD.
 * Всё остальное своё: дописку строит `childAppend`, процесс и разбор событий —
 * настоящая `LiveSession` (`spawnDirect` — трубы у самого скрипта, без
 * отвязанного посредника: проверяется CLI и разбор событий, а не посредник),
 * итог хода — настоящий `chainOutcomeOf` с флагом, как его ставит реестр
 * (`livePool.backgroundOf` = `alive && hasBackgroundWork`).
 *
 * Случаи:
 * - дописка группы доехала до модели и несёт исключение для фоновых подагентов;
 * - конец хода 1: `hasBackgroundWork`, в фоне задача `local_agent`;
 * - `chainOutcomeOf` по этому ходу → `background` (группа не «готова»);
 * - CLI сам начинает ход пробуждения (`onWake`), в нём — ответ модели и возврат
 *   подагента; по его концу фон пуст и итог уже не `background`.
 *
 * Каталог прогона — вне домашней папки (CLI собирает `.claude` всех родителей),
 * конфиг — свой `CLAUDE_CONFIG_DIR`. Запуск: `node tools/qa/check-split-agent-hold.mjs`;
 * нужен установленный `claude` (путь — `CLAUDE_CLI`); стенд и настройки человека
 * не трогаются.
 */
import { createServer } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, parse } from 'node:path';
import { tmpdir } from 'node:os';

const PREFIX = 'cc-agenthold-';
const START = 'start-hold-4417 run the review lanes';
const SUBTASK = 'SUBTASK-HOLD-4417 read the chunk and report';
const LANE_DONE = 'LANE-DONE-4417';
const WAKE_WORD = 'WOKE-4417';
const LAUNCHED_LINE = 'Lanes running: lane A. Ending the turn until it returns.';
/** Сколько думает подагент: ход 1 обязан кончиться раньше его ответа. */
const SUB_DELAY_MS = 8_000;
const EXCEPTION = 'Background subagents (Agent with run_in_background) are the exception';

let bad = 0;
const check = (ok, text) => {
  console.log(`${ok ? 'ок ' : 'НЕТ'} ${text}`);
  if (!ok) bad += 1;
};

function resolveClaude() {
  if (process.env.CLAUDE_CLI) return process.env.CLAUDE_CLI;
  if (process.platform !== 'win32') return 'claude';
  const tail = join('node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe');
  for (const root of [dirname(process.execPath), join(process.env.APPDATA ?? '', 'npm')]) {
    if (existsSync(join(root, tail))) return join(root, tail);
  }
  return '';
}

/** Каталог без `.claude` у родителей: на Windows временная папка лежит в домашней. */
function workBase() {
  for (let dir = tmpdir(); ; dir = dirname(dir)) {
    if (existsSync(join(dir, '.claude'))) break;
    if (dir === parse(dir).root) return tmpdir();
  }
  const pub = process.platform === 'win32' ? process.env.PUBLIC : '/tmp';
  if (pub && existsSync(pub)) return pub;
  throw new Error('нет каталога вне домашней папки: задайте PUBLIC');
}

const textOf = (content) => (typeof content === 'string' ? content : JSON.stringify(content ?? ''));

/**
 * Чей это вызов модели: главного разговора, подагента или служебный. Служебные
 * вызовы CLI (заголовок разговора и т. п.) тоже несут текст сообщения, но без
 * инструментов — по ним главный разговор и отличается.
 */
function whoCalls(body) {
  const first = textOf(body.messages?.[0]?.content);
  if (!(body.tools ?? []).length) return 'other';
  if (first.includes(START)) return 'main';
  if (first.includes(SUBTASK)) return 'sub';
  return 'other';
}

function sse(res, blocks, stopReason) {
  const events = [
    {
      type: 'message_start',
      message: {
        id: `msg_${Math.random().toString(36).slice(2)}`,
        type: 'message',
        role: 'assistant',
        model: 'stub',
        content: [],
        stop_reason: null,
        usage: { input_tokens: 10, output_tokens: 1 },
      },
    },
  ];
  blocks.forEach((block, index) => {
    if (block.type === 'text') {
      events.push(
        { type: 'content_block_start', index, content_block: { type: 'text', text: '' } },
        { type: 'content_block_delta', index, delta: { type: 'text_delta', text: block.text } },
      );
    } else {
      events.push(
        {
          type: 'content_block_start',
          index,
          content_block: { type: 'tool_use', id: block.id, name: block.name, input: {} },
        },
        {
          type: 'content_block_delta',
          index,
          delta: { type: 'input_json_delta', partial_json: JSON.stringify(block.input) },
        },
      );
    }
    events.push({ type: 'content_block_stop', index });
  });
  events.push(
    { type: 'message_delta', delta: { stop_reason: stopReason }, usage: { output_tokens: 1 } },
    { type: 'message_stop' },
  );
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
  for (const data of events) res.write(`event: ${data.type}\ndata: ${JSON.stringify(data)}\n\n`);
  res.end();
}

/** Стаб API: пишет каждый запрос и ведёт разговор по ролям вызова. */
function startStub() {
  const seen = [];
  const server = createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!req.url?.includes('/messages') || req.url.includes('count_tokens')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(req.url?.includes('count_tokens') ? '{"input_tokens":10}' : '{}');
        return;
      }
      let body = {};
      try {
        body = JSON.parse(raw);
      } catch {
        // пустое тело — тоже запрос
      }
      const who = whoCalls(body);
      seen.push({ who, body, at: Date.now() });
      if (who === 'sub') {
        setTimeout(() => sse(res, [{ type: 'text', text: LANE_DONE }], 'end_turn'), SUB_DELAY_MS);
        return;
      }
      if (who !== 'main') {
        sse(res, [{ type: 'text', text: 'ok' }], 'end_turn');
        return;
      }
      const history = JSON.stringify(body.messages ?? []);
      if (history.includes(LANE_DONE)) {
        sse(res, [{ type: 'text', text: WAKE_WORD }], 'end_turn');
        return;
      }
      const last = body.messages?.at(-1);
      const answered = textOf(last?.content).includes('tool_result');
      if (answered) {
        sse(res, [{ type: 'text', text: LAUNCHED_LINE }], 'end_turn');
        return;
      }
      const names = (body.tools ?? []).map((tool) => tool.name);
      const name = names.includes('Agent') ? 'Agent' : 'Task';
      sse(
        res,
        [
          {
            type: 'tool_use',
            id: 'toolu_hold_1',
            name,
            input: {
              description: 'Review lane A',
              prompt: SUBTASK,
              subagent_type: 'general-purpose',
              run_in_background: true,
            },
          },
        ],
        'tool_use',
      );
    });
  });
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () =>
      resolve({
        url: `http://127.0.0.1:${server.address().port}`,
        seen,
        close: () => server.close(),
      }),
    ),
  );
}

const withTimeout = (promise, ms, what) =>
  Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`${what}: нет за ${ms} мс`)), ms)),
  ]);

/** Текст ответа модели за ход — из событий `assistant` и `result`. */
const answerOf = (events) =>
  events
    .filter((event) => event.type === 'assistant')
    .flatMap((event) => event.message?.content ?? [])
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('\n');

async function main() {
  const exe = resolveClaude();
  if (!exe) throw new Error('claude не найден: задайте CLAUDE_CLI');
  const { childAppend, initiativePrompt } =
    await import('../../apps/server/src/domains/chat/initiative/initiative.ts');
  const { LiveSession } =
    await import('../../apps/server/src/domains/chat/live-session/live-session.ts');
  const { spawnDirect } =
    await import('../../apps/server/src/domains/chat/live-transport/live-transport.ts');
  const { chainOutcomeOf } =
    await import('../../apps/server/src/domains/chat/chain-outcome/chain-outcome.ts');
  const append = childAppend(
    initiativePrompt({ taskSplitInitiative: true, handoffInitiative: true }, { splitMuted: true }),
  );
  const stub = await startStub();
  const work = mkdtempSync(join(workBase(), PREFIX));
  const home = join(work, 'home');
  const project = join(work, 'proj');
  mkdirSync(home, { recursive: true });
  mkdirSync(project, { recursive: true });
  writeFileSync(join(home, 'settings.json'), '{}');
  const appendFile = join(work, 'append.txt');
  writeFileSync(appendFile, append, 'utf8');
  console.log(`CLI: ${exe}\nКаталог: ${work}\n`);

  const env = {
    ...process.env,
    CLAUDE_CONFIG_DIR: home,
    ANTHROPIC_BASE_URL: stub.url,
    ANTHROPIC_AUTH_TOKEN: 'hold-stub',
    ANTHROPIC_API_KEY: 'hold-stub',
    ANTHROPIC_MODEL: 'claude-sonnet-4-5',
    DISABLE_AUTOUPDATER: '1',
  };
  const args = [
    '-p',
    '--input-format',
    'stream-json',
    '--output-format',
    'stream-json',
    '--verbose',
    '--permission-mode',
    'bypassPermissions',
    '--append-system-prompt-file',
    appendFile,
  ];
  const session = new LiveSession(
    { command: exe, args, cwd: project, env, shell: false, signature: 'agent-hold' },
    Date.now,
    spawnDirect,
  );
  const link = { parentChatId: 'p', createdAt: '', branch: 'b', stage: 'work' };

  try {
    let woken;
    const wake = new Promise((resolve) => {
      session.onWake = () => {
        const events = [];
        const done = session.claimWake(undefined, (raw) => events.push(raw));
        woken = Date.now();
        done?.then((outcome) => resolve({ outcome, events }));
      };
    });

    const first = [];
    const outcome1 = await withTimeout(
      session.turn(START, undefined, (raw) => first.push(raw)),
      120_000,
      'ход 1',
    );
    const ended = Date.now();
    const mainCalls = stub.seen.filter((call) => call.who === 'main');
    check(
      mainCalls.length > 0 && JSON.stringify(mainCalls[0].body.system ?? '').includes(EXCEPTION),
      'дописка группы доехала до модели и несёт исключение для фоновых подагентов',
    );
    check(
      !outcome1.closed,
      `ход 1 кончился событием result, процесс жив (closed=${outcome1.closed})`,
    );
    check(
      answerOf(first).includes(LAUNCHED_LINE),
      'ход 1 кончился строкой с именами идущих дорожек',
    );
    const tasks = session.backgroundList;
    check(
      session.hasBackgroundWork && tasks.some((task) => task.type === 'local_agent'),
      `конец хода 1: hasBackgroundWork=${session.hasBackgroundWork}, фон ${JSON.stringify(tasks.map((t) => t.type))}`,
    );
    const held = chainOutcomeOf({
      link,
      ok: true,
      text: answerOf(first),
      background: session.alive && session.hasBackgroundWork,
    });
    check(
      held.status === 'background' && held.waitingFor === 'background',
      `chainOutcomeOf по ходу 1 → ${held.status}/${held.waitingFor ?? '-'} (группа держится)`,
    );

    // Фона нет — будить нечему: короткий срок, чтобы красное было отказом, а не зависанием.
    const wakeMs = session.hasBackgroundWork ? 120_000 : 15_000;
    const { outcome: outcome2, events: second } = await withTimeout(wake, wakeMs, 'пробуждение');
    const subCall = stub.seen.find((call) => call.who === 'sub');
    check(Boolean(subCall), 'подагент вызвал модель');
    check(
      woken !== undefined && woken > ended,
      `CLI сам начал ход пробуждения после конца хода 1 (+${woken ? woken - ended : '?'} мс)`,
    );
    check(!outcome2.closed, 'ход пробуждения кончился событием result');
    check(
      answerOf(second).includes(WAKE_WORD),
      'в ходе пробуждения — ответ модели на возврат подагента',
    );
    const wakeCall = stub.seen.filter((call) => call.who === 'main').at(-1);
    check(
      JSON.stringify(wakeCall?.body.messages ?? []).includes(LANE_DONE),
      'вызов модели в ходе пробуждения несёт результат подагента',
    );
    const after = chainOutcomeOf({
      link,
      ok: true,
      text: answerOf(second),
      background: session.alive && session.hasBackgroundWork,
    });
    check(
      after.status !== 'background',
      `по концу хода пробуждения фон пуст: chainOutcomeOf → ${after.status}`,
    );
  } finally {
    session.close();
    await Promise.race([session.whenClosed(), new Promise((r) => setTimeout(r, 12_000))]);
    stub.close();
    rmSync(work, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
  console.log(bad ? `\nПровалов: ${bad}` : '\nВсё ок');
  process.exit(bad ? 1 : 0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
