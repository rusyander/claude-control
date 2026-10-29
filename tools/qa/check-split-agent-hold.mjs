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
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, parse } from 'node:path';
import { tmpdir } from 'node:os';
import { startStubModel } from '../../packages/stub-model/src/index.mjs';

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

/** Стаб API: пишет каждый запрос и ведёт разговор по ролям вызова. */
async function startStub() {
  const seen = [];
  const stub = await startStubModel({
    // Вне `/messages` (служебные пути CLI) — пустой JSON, как было у своего стаба.
    route: ({ path }) => (path.includes('/messages') ? undefined : { body: {} }),
    script: ({ request }) => {
      const { body } = request;
      const who = whoCalls(body);
      seen.push({ who, body, at: Date.now() });
      // Подагент отвечает не сразу — главный разговор успевает закончить ход.
      if (who === 'sub') return { text: LANE_DONE, holdMs: SUB_DELAY_MS };
      if (who !== 'main') return 'ok';
      if (JSON.stringify(body.messages ?? []).includes(LANE_DONE)) return WAKE_WORD;
      if (textOf(body.messages?.at(-1)?.content).includes('tool_result')) return LAUNCHED_LINE;
      const name = request.tools.includes('Agent') ? 'Agent' : 'Task';
      const args = {
        description: 'Review lane A',
        prompt: SUBTASK,
        subagent_type: 'general-purpose',
        run_in_background: true,
      };
      return { tool: { name, args, id: 'toolu_hold_1' } };
    },
  });
  return { url: stub.baseUrl, seen, close: () => stub.close() };
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
