/**
 * Сквозной обход волны 2 этапа 12 через все её зоны — настоящая дорога: одноразовая панель, своё
 * ядро на временном доме, `packages/stub-tracker` — сайт Jira панели, `packages/stub-forge` — GitLab,
 * `telegram-bot-stub.mjs` — Bot API. Подменена только сеть (трекер, форж, Telegram); ответы панели и
 * ядра не перехватываются (кроме данных прогона «Тестов» — их отдаёт заглушка ответов сервера).
 *
 * Что видно, по порядку:
 *   1. источники (jira + gitlab, «Ответ в тикет») окном доски → опрос → строка и колонка «Входящие»
 *      → поиск по ключу и словами → «Во входящие» → «Сценарий» → «В очередь» → старт задачи;
 *   2. свой MR с открытым обсуждением — одна запись через два круга опроса, одна задача ответа;
 *   3. MR слит на форже — карточка задачи уходит в «Влит» сама;
 *   4. переключатель «Отвечать ядру из Telegram» → вопрос ядра в чате с кнопками и ссылкой на задачу
 *      → нажатие → вопрос закрыт, доска это показывает;
 *   5. ответ в тикет: вопрос пункта 9 в Telegram без «Разрешить», пометка «запись в тикет» в окне
 *      карточки, ответ из панели → один комментарий в тикете;
 *   6. `/task` без репозиториев — без «В работу»; поле репозиториев → «В работу» → «Запущена»;
 *   7. «На доску» из «Тестов» — запись, после перезагрузки второй нет;
 *   8. тихие часы: конец задачи придержан, по концу окна — сводка «Пока было тихо».
 *
 * Запуск: `node tools/qa/check-core-w2-cross-zone-live.mjs` (стенд свой, `pnpm dev` не нужен).
 * `SHOTS=<dir>` — кадры. Код выхода: 0 — сходится, 1 — провал, 2 — стенд.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { REPO, runOnStand, wait } from './throwaway-stand.mjs';
import { startBotStub } from './telegram-bot-stub.mjs';
import {
  has,
  singleCard,
  until,
  walkCommentBack,
  walkInbox,
  walkOwnMr,
  walkSweep,
  walkTestsToBoard,
} from './core-w2-walk-legs.mjs';

const { writeToken } = await import('../../apps/server/src/domains/integrations/store/store.ts');
const { startStubTracker } = await import('../../packages/stub-tracker/src/index.mjs');
const { startStubForge } = await import('../../packages/stub-forge/src/index.mjs');

const SHOTS = process.env.SHOTS ?? '';
if (SHOTS) mkdirSync(SHOTS, { recursive: true });
const OWNER = 424260;
const TOKEN = '7000009:QA_w2_walk_secret_ABCDEFGH';
/** Тихие часы: с минуты назад до QUIET_MIN минут вперёд по местным часам. */
const QUIET_MIN = 6;
const hhmm = (ms) => {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};
const startedAt = Date.now();
const quiet = {
  from: hhmm(startedAt - 60_000),
  to: hhmm(startedAt + QUIET_MIN * 60_000),
  asks: false,
};

const tracker = await startStubTracker({
  deployment: 'cloud',
  issues: [
    { key: 'PROJ-1', summary: 'Login epic', type: 'Epic' },
    {
      key: 'PROJ-2',
      summary: 'Login button does nothing',
      type: 'Bug',
      labels: ['agentdeck'],
      assignee: 'agent',
    },
    { key: 'PROJ-4', summary: 'Export report as CSV', type: 'Story', labels: ['agentdeck'] },
    { key: 'PROJ-5', summary: 'Password reset email is not sent', type: 'Task' },
    { key: 'PROJ-7', summary: 'Answer into the ticket', type: 'Bug' },
  ],
});
const forge = await startStubForge({});
const tgStub = await startBotStub({
  botId: 7000009,
  username: 'qa_w2_walk_bot',
  tokens: [TOKEN],
  owner: OWNER,
  firstMessageId: 2100,
});
const { bot, say, push } = tgStub;
const tg = {
  sent: () => bot.calls.filter((call) => call.method === 'sendMessage'),
  edits: () => bot.calls.filter((call) => call.method === 'editMessageText'),
  textOf: (call) => String(call?.body?.text ?? ''),
  keyboardOf: (call) => (call?.body?.reply_markup?.inline_keyboard ?? []).flat(),
};
const plain = (html) =>
  String(html)
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&');
/** Нажатие кнопки под сообщением бота — колбэк в очередь заглушки, как от человека. */
const press = (card, button) =>
  push({
    update_id: bot.nextUpdateId++,
    callback_query: {
      id: `cb-w2-${bot.nextUpdateId}`,
      from: { id: OWNER, is_bot: false, first_name: 'Q' },
      data: button.callback_data,
      message: {
        message_id: card.messageId,
        chat: { id: OWNER, type: 'private' },
        text: plain(card.body.text),
        reply_markup: card.body.reply_markup,
      },
    },
  });

// Свой MR с обсуждением ревьюера (iid 1) и MR задачи обхода (iid 2) — открыты публикатором.
forge.act('publisher', {
  type: 'mr-open',
  sourceBranch: 'feature/own',
  targetBranch: 'main',
  title: 'Свой MR с обсуждением',
});
forge.act('reviewer', { type: 'note', mrIid: 1, body: 'Переименуй функцию', resolvable: true });
const sweepMr = forge.act('publisher', {
  type: 'mr-open',
  sourceBranch: 'agentdeck/sweep',
  targetBranch: 'main',
  title: 'MR обхода',
});
const sweepIid = Number(sweepMr.iid);

const git = (cwd, ...args) => {
  const out = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });
  if (out.status !== 0) throw new Error(`git ${args.join(' ')}: ${out.stderr}`);
};
const node = (script, args) => {
  const out = spawnSync(
    process.execPath,
    ['--experimental-strip-types', '--no-warnings', join(REPO, 'tools/qa', script), ...args],
    { encoding: 'utf8' },
  );
  if (out.status !== 0) throw new Error(`${script}: ${out.stderr}`);
  return JSON.parse(out.stdout.trim().split('\n').at(-1));
};
/** Репозиторий с `origin` (голый каталог), пуш — на адрес форжа: так ядро узнаёт сайт MR. */
function makeRepo(root, name, branches = []) {
  const repo = join(root, name);
  const bare = join(root, `${name}-origin.git`);
  mkdirSync(repo, { recursive: true });
  mkdirSync(bare, { recursive: true });
  git(bare, 'init', '-q', '--bare', '-b', 'main');
  git(repo, 'init', '-q', '-b', 'main');
  writeFileSync(join(repo, 'README.md'), `# ${name}\n`, 'utf8');
  git(repo, 'add', '.');
  git(repo, '-c', 'user.name=qa', '-c', 'user.email=qa@example.com', 'commit', '-q', '-m', 'init');
  git(repo, 'remote', 'add', 'origin', bare);
  git(repo, 'push', '-q', 'origin', 'main');
  for (const branch of branches) git(repo, 'push', '-q', 'origin', `main:refs/heads/${branch}`);
  git(repo, 'fetch', '-q', 'origin');
  git(repo, 'config', 'remote.origin.pushurl', `${forge.url}/acme/app.git`);
  return repo;
}

let seeded;
let ask;
let repo = '';
let tgRepo = '';
try {
  await runOnStand(
    {
      label: 'w2-walk',
      core: true,
      web: true,
      // Предполётная проверка CLI маршрута: фальшивый `claude` называет версию и выходит.
      fakeCli: {
        claude:
          "if (process.argv.includes('--version')) console.log('2.1.0 (Claude Code)');\nprocess.exit(0);\n",
      },
      env: {
        AGENTDECK_CORE_SUPERVISE: '0',
        AGENTDECK_TELEGRAM_API: tgStub.url,
        AGENTDECK_TELEGRAM_SEND_GRACE_MS: '0',
      },
      settings: {
        integrations: {
          jira: {
            enabled: true,
            baseUrl: tracker.url,
            email: 'agent@tracker.example.com',
            deployment: 'cloud',
          },
          gitlab: { enabled: true, baseUrl: forge.url, repo: '101' },
          telegram: { enabled: true, chatId: String(OWNER), events: ['question'], quiet },
        },
      },
      seed: ({ root, cfg, coreHome }) => {
        const state = join(cfg, 'agentdeck');
        repo = makeRepo(root, 'repo', ['feature/own', 'agentdeck/sweep']);
        tgRepo = makeRepo(root, 'tg-repo');
        writeToken(state, 'jira', tracker.tokens.agent);
        writeToken(state, 'gitlab', forge.tokens.publisher);
        writeToken(state, 'telegram', TOKEN);
        const configFile = join(coreHome, 'config.json');
        const config = JSON.parse(readFileSync(configFile, 'utf8'));
        config.board = {
          inWork: 4,
          perDay: null,
          paused: false,
          stopOnQuestion: false,
          defaultStop: 'mr',
        };
        writeFileSync(configFile, `${JSON.stringify(config, null, 2)}\n`);
        ask = node('core-ask-seed.mjs', [coreHome, 'Обход: вопрос запуска']);
        seeded = node('core-w2-walk-seed.mjs', [coreHome, repo, forge.url, String(sweepIid)]);
        // Концы задач засева — «сегодняшние»: первый проход уведомлений их не пропустит.
        writeFileSync(
          join(state, 'telegram-notices.json'),
          `${JSON.stringify({ version: 1, lastPumpAt: Date.now() })}\n`,
        );
      },
    },
    async (stand, check) => {
      const ctx = { stand, check, tracker, forge, tg, press, seeded, repo, sweepIid, SHOTS };
      const leg = async (name, run) => {
        const t0 = Date.now();
        try {
          await run();
        } catch (error) {
          check(
            `нога «${name}» дошла до конца`,
            false,
            String(error?.stack ?? error).slice(0, 600),
          );
        }
        console.log(`  · нога «${name}»: ${Math.round((Date.now() - t0) / 1000)} с`);
      };
      const answers = await stand.api('/integrations/telegram/answers', {
        method: 'PUT',
        body: { enabled: true, afterMinutes: 0, ownerId: String(OWNER), token: TOKEN },
      });
      check('ответы из Telegram включены', answers.status === 200, answers.text.slice(0, 300));
      const browser = await chromium.launch();
      try {
        const page = await stand.newPage(browser, { width: 1600, height: 1100 });
        page.setDefaultTimeout(10_000);
        await leg('входящие', () => walkInbox(ctx, page));
        await leg('свой MR', () => walkOwnMr(ctx, page));
        await leg('обход MR', () => walkSweep(ctx, page));
        await leg('привязка Telegram', () => walkBinding(ctx, page));
        await leg('ответ в тикет', () => walkCommentBack(ctx, page));
        await leg('/task', () => walkTask(ctx, page));
        await leg('«На доску»', () => walkTestsToBoard(ctx, browser));
        await leg('тихие часы', () => walkQuiet(ctx));
        check('страница обхода без ошибок', page.errors.length === 0, page.errors.join(' | '));
        const leaks = [tracker.tokens.agent, forge.tokens.publisher, TOKEN].filter((secret) =>
          bot.calls.some((call) => JSON.stringify(call.body ?? {}).includes(secret)),
        );
        check('ни одно значение доступа не ушло в Telegram', leaks.length === 0);
      } finally {
        await browser.close();
      }
    },
  );
} finally {
  await tgStub.close();
  await forge.close?.();
  await tracker.stop();
}

// ── 4. привязка Telegram → вопрос ядра кнопками → нажатие → доска ───────────────────────────────

async function walkBinding(ctx, page) {
  const { stand, check } = ctx;
  await page.goto(`${stand.webUrl}/settings?tab=integrations`, { waitUntil: 'domcontentloaded' });
  const block = page.locator('[data-telegram-core-binding]');
  check(
    'переключатель «Отвечать ядру из Telegram» выключен',
    await has(page.locator('[data-telegram-core-binding="unbound"]'), 60_000),
  );
  await block.getByRole('switch').click();
  check(
    'после нажатия — включён',
    await has(page.locator('[data-telegram-core-binding="bound"]'), 30_000),
  );
  // Открытых вопросов к этому мигу несколько (засев, пункт 9, ответ ревьюерам) — бот шлёт сводку;
  // вопрос запуска нога выносит из неё кнопкой «Ответить», как человек.
  const { card } = await singleCard(ctx, 'Launch the task?', 60_000);
  check(
    'вопрос ядра пришёл в чат кнопками со ссылкой «Открыть задачу →» на вопрос',
    Boolean(card) &&
      tg.textOf(card).includes(`/core?id=${ask.taskId}&amp;ask=${ask.askId}`) &&
      tg.keyboardOf(card).some((b) => b.text.includes('Отменить задачу')),
    JSON.stringify({
      text: tg.textOf(card).slice(-240),
      labels: tg.keyboardOf(card).map((b) => b.text),
    }),
  );
  const cancel = tg.keyboardOf(card).find((b) => b.text.includes('Отменить задачу'));
  if (!cancel) return;
  press(card, cancel);
  const closed = await until(async () => {
    const view = (await stand.api(`/core/tasks/${ask.taskId}`)).body?.view;
    const one = view?.asks?.find((a) => a.askId === ask.askId);
    return one && one.state !== 'open' ? one : null;
  });
  check('нажатие «Отменить задачу» — ядро закрыло вопрос', Boolean(closed), JSON.stringify(closed));
  const boardCard = await until(async () => {
    const c = ((await stand.api('/core/board')).body?.cards ?? []).find((x) => x.id === ask.taskId);
    return c && !c.waiting ? c : null;
  });
  await page.goto(`${stand.webUrl}/core`, { waitUntil: 'domcontentloaded' });
  const waitingCol = page.locator(
    `[data-board-column="waiting"] [data-board-card="${ask.taskId}"]`,
  );
  await has(page.locator('[data-board-inbox]'), 30_000);
  check(
    'доска показывает ответ: карточка больше не ждёт человека',
    Boolean(boardCard) && (await waitingCol.count()) === 0,
    JSON.stringify(boardCard),
  );
}

// ── 6. /task ────────────────────────────────────────────────────────────────────────────────────

async function walkTask(ctx, page) {
  const { stand, check } = ctx;
  const fromTelegram = async () =>
    ((await stand.api('/core/board')).body?.entries ?? []).filter(
      (e) => e.source?.kind === 'telegram',
    );
  const sentWith = (needle) => tg.sent().filter((c) => tg.textOf(c).includes(needle));
  say('/task проверить вход');
  const first = await until(() => sentWith('Во «Входящих»: проверить вход')[0], 30_000);
  check(
    '/task без репозиториев: запись во «Входящих», «В работу» нет, подсказка',
    (await fromTelegram()).length === 1 &&
      !tg.keyboardOf(first).some((b) => b.text === '▶️ В работу') &&
      tg.textOf(first).includes('Репозиторий не задан'),
    JSON.stringify({ reply: tg.textOf(first), entries: await fromTelegram() }).slice(0, 500),
  );
  await page.goto(`${stand.webUrl}/settings?tab=integrations`, { waitUntil: 'domcontentloaded' });
  const block = page.locator('[data-telegram-core-binding]');
  await has(block, 30_000);
  await block.getByLabel('Репозитории для задач из Telegram').fill(tgRepo);
  await block.getByRole('button', { name: 'Сохранить репозитории' }).click();
  const repos = await until(
    async () => (await stand.api('/core/config')).body?.doc?.telegram?.repos,
  );
  check('поле репозиториев записано в настройку ядра', repos?.length === 1, JSON.stringify(repos));
  say('/task проверить выход');
  const second = await until(() => sentWith('Во «Входящих»: проверить выход')[0], 30_000);
  const work = tg.keyboardOf(second).find((b) => b.text === '▶️ В работу');
  check('/task с репозиторием — ответ с «В работу»', Boolean(work), tg.textOf(second));
  if (!work) return;
  const editsBefore = tg.edits().length;
  push({
    update_id: bot.nextUpdateId++,
    callback_query: {
      id: `cb-work-${bot.nextUpdateId}`,
      from: { id: OWNER, is_bot: false, first_name: 'Q' },
      message: {
        message_id: second.messageId,
        chat: { id: OWNER, type: 'private' },
        reply_to_message: { message_id: second.body.reply_parameters?.message_id },
      },
      data: work.callback_data,
    },
  });
  const settled = await until(
    () =>
      tg
        .edits()
        .slice(editsBefore)
        .find(
          (c) =>
            Number(c.body.message_id) === second.messageId &&
            /Запущена|Не запущена/.test(tg.textOf(c)),
        ),
    60_000,
  );
  const entry = (await fromTelegram()).find((e) =>
    JSON.stringify(e.launch).includes('проверить выход'),
  );
  check(
    '«В работу» — запись стартовала задачей, под сообщением «Запущена»',
    /Запущена/.test(tg.textOf(settled)) &&
      !/Не запущена/.test(tg.textOf(settled)) &&
      entry?.state === 'started',
    JSON.stringify({ text: tg.textOf(settled), entry: [entry?.state, entry?.reason] }),
  );
}

// ── 8. тихие часы → сводка ──────────────────────────────────────────────────────────────────────

async function walkQuiet(ctx) {
  const { check, seeded: s } = ctx;
  const title = 'Обход: MR на форже';
  const single = tg
    .sent()
    .filter((c) => tg.textOf(c).includes(title) && !tg.textOf(c).includes('🌙'));
  check(
    `тихие часы ${quiet.from}–${quiet.to}: конец задачи отдельным сообщением не ушёл`,
    single.length === 0,
    JSON.stringify(single.map((c) => tg.textOf(c).slice(0, 120))),
  );
  const left = startedAt + (QUIET_MIN + 1.5) * 60_000 - Date.now();
  const digest = await until(
    () => tg.sent().find((c) => tg.textOf(c).includes('Пока было тихо')),
    Math.max(left, 30_000),
    1000,
  );
  check(
    'по концу окна — сводка «Пока было тихо» с концом задачи',
    Boolean(digest) && tg.textOf(digest).includes(title),
    tg.textOf(digest).slice(0, 400) || `нет сводки; задача ${s.sweep}`,
  );
  await wait(0);
}
