/**
 * Лимит окна в чате — настоящая дорога (этап 12, P171): одноразовая панель, своё ядро, настоящий
 * claude из PATH человека против `packages/stub-model` (подменена только модель: вход подписки —
 * поддельный токен, адрес — заглушка, прокси мёртвый, сеть вендора недостижима). Заглушка отказывает
 * окном (429 + `rate_limit_event` rejected) до момента сброса, после — отвечает.
 *
 * Что видно:
 *   - ход упёрся в окно — карточка лимита в открытом чате: «Ждать сброса» и «Перенести в X» для
 *     КАЖДОГО CLI со входом в PATH (здесь codex: стоит и его конфигурация есть), кроме CLI
 *     разговора (claude) и CLI без входа (qwen без конфигурации);
 *   - без клика ничего не уходит: ни `/chat/send`, ни перенос (`/portable/carry`), активный
 *     провайдер тот же;
 *   - после сброса ядро само шлёт слово ещё раз — ответ на него появляется в ОТКРЫТОМ чате без
 *     перезагрузки, и карточка лимита уходит;
 *   - шапка держит «лимит до …», пока окно закрыто, и снимает его после сброса;
 *   - грант автоподтверждения ядро принимает (проект — ключ единицы задачи).
 *
 * Запуск: `node tools/qa/check-chat-limit-live.mjs` (стенд свой, `pnpm dev` не нужен). `PLAIN_FOLDER=1`
 * — то же в папке без git (у задачи ядра нет репозитория). `SHOTS=<dir>`
 * — кадры в обеих темах, `SHOT_TAG=BEFORE|AFTER` — суффикс кадра.
 * Код выхода: 0 — сходится, 1 — провал, 2 — не проверено.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const SHOTS = process.env.SHOTS || '';
const SHOT_TAG = process.env.SHOT_TAG || 'AFTER';
/** Папка проекта без git (`PLAIN_FOLDER=1`): у задачи ядра нет репозитория, единица — без него. */
const PLAIN_FOLDER = process.env.PLAIN_FOLDER === '1';
/** Окно отказывает столько после первого хода: успеть увидеть карточку и проверить «без клика». */
const WINDOW_MS = 45_000;

const { chromium } = await import('playwright');
const { runOnStand, NotChecked, wait } = await import('./throwaway-stand.mjs');
const { openProjectChat } = await import('./chat-walk.mjs');
const { startStubModel } = await import('../../packages/stub-model/src/index.mjs');

const cliAt = (name) => {
  const r = spawnSync(process.platform === 'win32' ? 'where' : 'which', [name], {
    encoding: 'utf8',
  });
  return r.status === 0 ? r.stdout.split(/\r?\n/)[0].trim() : '';
};
const claude = cliAt('claude');
const codex = cliAt('codex');

/** Слова человека в последнем его сообщении запроса (строка или текстовые блоки). */
function lastWords(body) {
  const messages = Array.isArray(body?.messages) ? body.messages : [];
  const human = messages.filter((m) => m?.role === 'user').at(-1);
  if (!human) return '';
  if (typeof human.content === 'string') return human.content;
  return (Array.isArray(human.content) ? human.content : [])
    .filter((b) => b?.type === 'text')
    .map((b) => b.text)
    .join('\n');
}

/**
 * Момент сброса окна (сек) по метке разговора — от первого хода с ней; до него каждый ход с меткой
 * отказан. `ход-1` — разговор ждёт сброса, `ход-2` — разговор переносят в codex.
 */
const resets = {};
const turns = { 'ход-1': [], 'ход-2': [] };
/** Каждый запрос к заглушке: время и последние слова человека (разбор провала). */
const seen = [];
const stub = await startStubModel({
  script: (ctx) => {
    const said = lastWords(ctx.request.body);
    seen.push(`${new Date().toISOString()} ${said.slice(0, 160)}`);
    const mark = /ход-[12]/.exec(said)?.[0];
    if (!mark) return { text: 'stub side reply' };
    turns[mark].push(Date.now());
    resets[mark] ??= Math.ceil((Date.now() + WINDOW_MS) / 1000);
    const resetsAt = resets[mark];
    if (Date.now() < resetsAt * 1000) {
      return {
        error: { status: 429, type: 'rate_limit_error', message: 'rate limited' },
        window: { utilization: 1, resetsAt, status: 'rejected', claim: 'five_hour' },
      };
    }
    return { text: `ответ на ${mark} после сброса` };
  },
});
// Вход подписки (не ключ API): окно подписки CLI сообщает только ему. Прокси мёртвый — до
// вендора не дойти ничем, адрес заглушки на loopback идёт мимо прокси.
const stubEnv = {
  ANTHROPIC_BASE_URL: stub.baseUrl,
  ANTHROPIC_MODEL: 'stub-model',
  CLAUDE_CODE_OAUTH_TOKEN: 'FAKE-VENDOR-OAUTH',
  HTTPS_PROXY: 'http://127.0.0.1:9',
  HTTP_PROXY: 'http://127.0.0.1:9',
  NO_PROXY: '127.0.0.1,localhost',
};

let repo = '';
await runOnStand(
  {
    label: 'chat-limit-live',
    extraPath: [...new Set([claude, codex].filter(Boolean).map((p) => dirname(p)))],
    env: stubEnv,
    core: true,
    seed: ({ root, home }) => {
      repo = join(root, 'repo');
      mkdirSync(repo, { recursive: true });
      writeFileSync(join(repo, 'README.md'), '# repo\n');
      // Опора переноса: без неё разговор не кандидат и «Перенести в codex» отказывает.
      mkdirSync(join(repo, '.agent'), { recursive: true });
      writeFileSync(join(repo, '.agent', 'PROGRESS.md'), 'Состояние работы.\n');
      // Репозиторий git, как у человека; `PLAIN_FOLDER=1` — папка без git: грант автоподтверждения
      // идёт единице ядра без репозитория задачи и тоже должен приниматься.
      if (PLAIN_FOLDER) return seedCodex(home);
      for (const args of [
        ['init', '-q', '-b', 'main'],
        ['config', 'user.name', 'stand'],
        ['config', 'user.email', 'stand@example.invalid'],
        ['add', '.'],
        ['commit', '-qm', 'init'],
      ]) {
        const r = spawnSync('git', args, { cwd: repo, encoding: 'utf8' });
        if (r.status) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
      }
      seedCodex(home);
    },
  },
  async (stand, check) => {
    if (!claude) throw new NotChecked('claude нет в PATH — чат через ядро не проверен');
    if (!codex) throw new NotChecked('codex нет в PATH — цель переноса не проверена');
    seedClaudeEnv(stand);
    const browser = await chromium.launch();
    try {
      await scenario(stand, check, browser);
    } finally {
      await browser.close();
      await stub.close();
    }
  },
);

/** Вход codex = его конфигурация в доме стенда (детект панели: `configPresent`). */
function seedCodex(home) {
  mkdirSync(join(home, '.codex'), { recursive: true });
  writeFileSync(join(home, '.codex', 'config.toml'), 'model = "stub-model"\n');
}

/** Вход claude стенда — адрес заглушки в `env` личного settings.json (как в `check-diff-notes`). */
function seedClaudeEnv(stand) {
  const path = join(stand.cfg, 'settings.json');
  const settings = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : {};
  writeFileSync(
    path,
    `${JSON.stringify({ ...settings, env: { ...settings.env, ...stubEnv } }, null, 2)}\n`,
  );
}

async function until(probe, seconds) {
  for (let i = 0; i < seconds * 4; i++) {
    if (await probe()) return true;
    await wait(250);
  }
  return false;
}

async function shoot(page, name) {
  if (!SHOTS) return;
  mkdirSync(SHOTS, { recursive: true });
  for (const theme of ['light', 'dark']) {
    await page.evaluate((t) => {
      document.documentElement.dataset.theme = t;
      document.documentElement.style.colorScheme = t;
    }, theme);
    await page.waitForTimeout(300);
    await page.screenshot({ path: join(SHOTS, `${name}-${theme}_${SHOT_TAG}.png`) });
  }
  await page.evaluate(() => {
    document.documentElement.dataset.theme = 'light';
    document.documentElement.style.colorScheme = 'light';
  });
}

async function scenario(stand, check, browser) {
  const page = await openProjectChat(stand, browser, repo, 'repo');
  // Всё, что меняет: ход, перенос, провайдер, настройки — любой не-GET к API панели.
  const posts = [];
  page.on('request', (req) => {
    if (req.method() === 'GET' || req.method() === 'HEAD') return;
    if (!req.url().includes('/api/')) return;
    const body = req.postData() ?? '';
    // Грант правки автоподтверждения (тумблер чата, `useCoreAutoGrant`) — не перенос и не ход.
    if (req.url().includes('/api/core/commands') && body.includes('"kind":"grant"')) return;
    posts.push({ url: req.url(), body, at: Date.now() });
  });
  // Ответы ядра на грант автоподтверждения: отказ — красная плашка человеку посреди чата.
  const grants = [];
  page.on('response', async (res) => {
    const body = res.request().postData() ?? '';
    if (!res.url().includes('/api/core/commands') || !body.includes('"kind":"grant"')) return;
    grants.push(await res.text().catch((err) => `unread: ${String(err)}`));
  });
  const chip = page.getByText(/^лимит до \d/);
  // Перезагрузка = новый документ (`load`), а не смена адреса внутри приложения.
  let navigations = 0;
  page.on('load', () => (navigations += 1));
  const activeOf = async () => (await stand.api('/providers/detect')).body?.active;
  const activeBefore = await activeOf();

  await page.getByRole('button', { name: 'Новый чат', exact: true }).first().click();
  await wait(1000);
  const input = page.locator('textarea[data-chat-input]');
  await input.fill('ход-1: привет');
  await input.press('Enter');
  const sentAt = Date.now();

  const card = page.locator('[data-chat-limit]');
  const cardShown = await until(() => card.count(), 120);
  check('ход упёрся в окно — карточка лимита в открытом чате', cardShown);
  if (!cardShown) return;
  const navBefore = navigations;
  const offers = await card
    .locator('[data-chat-limit-offer]')
    .evaluateAll((els) => els.map((e) => e.getAttribute('data-chat-limit-offer')));
  check(
    `карточка предлагает «Перенести в codex» (${offers.join(', ')})`,
    offers.includes('cli:codex'),
  );
  check('CLI разговора (claude) себе не предлагается', !offers.includes('cli:claude'));
  check('CLI без входа (qwen без конфигурации) не предлагается', !offers.includes('cli:qwen'));
  check(
    'кнопка переноса подписана «Перенести в codex»',
    (await card.getByRole('button', { name: /Перенести в codex/ }).count()) === 1,
  );
  check('шапка: «лимит до …», пока окно закрыто', (await chip.count()) > 0);
  await shoot(page, 'chat-limit-live-card');

  // Без клика ничего не уходит, пока окно закрыто.
  const sendsAfterTurn = () => posts.filter((p) => p.at > sentAt + 500);
  await wait(8000);
  check(
    `без клика панель ничего не шлёт (${
      sendsAfterTurn()
        .map((p) => `${p.url} ${p.body.slice(0, 300)}`)
        .join(', ') || 'пусто'
    })`,
    sendsAfterTurn().length === 0,
  );
  const activeAfter = await activeOf();
  check(
    `активный провайдер не сменился сам (${activeBefore} → ${activeAfter})`,
    Boolean(activeBefore) && activeBefore === activeAfter,
  );

  // Сброс: ядро шлёт слово ещё раз — ответ в открытом чате, без перезагрузки страницы.
  const resetsAt = resets['ход-1'] ?? 0;
  const left = resetsAt * 1000 - Date.now();
  const answered = await until(
    () => page.getByText('ответ на ход-1 после сброса').count(),
    Math.ceil(left / 1000) + 120,
  );
  check(
    `после сброса модель получила слово ещё раз (ходов с меткой: ${turns['ход-1'].length})`,
    turns['ход-1'].some((t) => t >= resetsAt * 1000),
  );
  check('ответ после сброса появился в открытом чате', answered);
  check('страница не перезагружалась', navigations === navBefore);
  check(
    'карточка лимита ушла после ответа',
    await until(async () => (await card.count()) === 0, 15),
  );
  check(
    'шапка: «лимит до …» ушла после сброса',
    await until(async () => (await chip.count()) === 0, 15),
  );
  check(
    `ход после сброса панель не слала сама (${sendsAfterTurn().length})`,
    sendsAfterTurn().length === 0,
  );
  check(
    `грант автоподтверждения ядро приняло (${grants.join(' | ') || 'гранта не было'})`,
    grants.length > 0 && grants.every((g) => !g.includes('rejected')),
  );
  await shoot(page, 'chat-limit-live-answer');
  try {
    await carryScenario(stand, check, page);
  } finally {
    if (process.env.JOURNAL_DUMP) {
      writeFileSync(process.env.JOURNAL_DUMP, `${seen.join('\n')}\n${journalDump(stand)}`);
    }
  }
}

/**
 * Второй разговор упирается в окно, и человек жмёт «Перенести в codex» (ревью этапа 12, R6):
 * перенос — выбор, где разговор продолжится, поэтому после сброса прежний CLI слова ещё раз не
 * получает, а задача ядра прежнего разговора отменена с причиной в журнале.
 */
async function carryScenario(stand, check, page) {
  await page.getByRole('button', { name: 'Новый чат', exact: true }).first().click();
  await wait(1000);
  const input = page.locator('textarea[data-chat-input]');
  await input.fill('ход-2: привет');
  await input.press('Enter');
  const card = page.locator('[data-chat-limit]');
  const cardShown = await until(() => card.count(), 120);
  check('перенос: второй разговор упёрся в окно — карточка лимита', cardShown);
  if (!cardShown) return;
  await card.getByRole('button', { name: /Перенести в codex/ }).click();
  const status = card.locator('[data-chat-limit-status]');
  await until(
    async () =>
      (await status.count()) > 0 &&
      (await status.first().getAttribute('data-chat-limit-status')) !== 'sending',
    60,
  );
  const state = (await status.count())
    ? await status.first().getAttribute('data-chat-limit-status')
    : '';
  const said = (await status.count()) ? await status.first().innerText() : '';
  check(`перенос: «Перенести в codex» перенёс разговор (${state}: ${said})`, state === 'carried');
  await shoot(page, 'chat-limit-live-carried');

  // Сброс окна прежнего CLI и ещё полминуты: повтора быть не должно.
  const resetsAt = resets['ход-2'] ?? 0;
  await wait(Math.max(0, resetsAt * 1000 - Date.now()) + 30_000);
  const late = turns['ход-2'].filter((t) => t >= resetsAt * 1000);
  check(
    `перенос: после сброса прежний CLI слова ещё раз не получил (ходов после сброса: ${late.length})`,
    resetsAt > 0 && late.length === 0,
  );
  check(
    'перенос: ответа прежнего CLI после сброса в чате нет',
    (await page.getByText('ответ на ход-2 после сброса').count()) === 0,
  );
  const why = cancelledByCarry(stand);
  check(
    `перенос: задача прежнего разговора отменена с причиной в журнале (${why || 'нет'})`,
    Boolean(why),
  );
}

/** Задача ядра, отменённая переносом: команда `cancel` с причиной «carried to codex» в журнале. */
function cancelledByCarry(stand) {
  const tasks = join(stand.coreHome, 'tasks');
  if (!existsSync(tasks)) return '';
  for (const taskId of readdirSync(tasks)) {
    const files = readdirSync(join(tasks, taskId)).filter((f) => f.endsWith('.jsonl'));
    const text = files.map((f) => readFileSync(join(tasks, taskId, f), 'utf8')).join('\n');
    if (/carried to codex/.test(text) && /"cancelled"/.test(text)) return taskId;
  }
  return '';
}

/** Журналы задач ядра стенда — разбор провала (`JOURNAL_DUMP=<файл>`). */
function journalDump(stand) {
  const tasks = join(stand.coreHome, 'tasks');
  if (!existsSync(tasks)) return '';
  const sessionFiles = (taskId) => {
    const dir = join(tasks, taskId, 'sessions');
    if (!existsSync(dir)) return [];
    return readdirSync(dir, { recursive: true })
      .map(String)
      .filter((f) => /\.(json|jsonl|log|txt)$|stdin|stdout|stderr/.test(f))
      .map((f) => join(dir, f))
      .filter((f) => !statSync(f).isDirectory())
      .map((f) => `## ${f}\n${readFileSync(f, 'utf8').slice(0, 6000)}`);
  };
  return readdirSync(tasks)
    .flatMap((taskId) => [
      ...readdirSync(join(tasks, taskId))
        .filter((f) => f.endsWith('.jsonl'))
        .map((f) => `## ${taskId}/${f}\n${readFileSync(join(tasks, taskId, f), 'utf8')}`),
      ...sessionFiles(taskId),
    ])
    .join('\n');
}
