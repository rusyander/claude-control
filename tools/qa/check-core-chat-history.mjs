/**
 * История чата не-Claude CLI на ядре (этап 11, волна 3): разговор чужого CLI ведёт себя как
 * разговор Claude. Настоящая дорога: одноразовая панель, своё ядро, настоящие CLI из PATH человека
 * за одноразовым контуром (`stub-platform.mjs` за шлюзом ядра стенда) — подменена только модель.
 *
 * Что видно для каждого CLI из `--foreign=` (по умолчанию qwen,opencode):
 *   - три хода подряд — под каждым словом человека его ответ, прежние ответы не уходят из ленты (a);
 *   - F5 — те же три слова и три ответа: история из вида сеанса ядра, не из памяти вкладки (b);
 *   - чат в боковом списке проекта (c); открыт заново из списка — лента с историей, новый ход идёт
 *     в тот же сеанс ядра (новой задачи нет, сеанс тот же, контур видит прежние слова разговора);
 *   - Claude не тронут: разговор claude в два хода после F5 читается из транскрипта, как прежде.
 *
 * Продолжение в чистой сессии к чужому CLI (`--handoff=qwen`, по умолчанию выключено): чат Claude
 * предлагает продолжение блоком, человек выбирает CLI и жмёт «Продолжить в новом чате» — новый
 * разговор этого CLI в списке (компьютер и телефон), переживает F5, открыт из списка — ход в тот же
 * сеанс ядра (новых задач 0). Первая реплика продолжения — без инициативы панели (она уходит CLI
 * текстом задания, но в ленте её нет, как у Claude).
 *
 * Перенос незакрытой работы к чужому CLI (`--carry=qwen`, по умолчанию выключено): разговор Claude
 * с опорой `.agent/PROGRESS.md`, активный CLI переключён, «Перенести» (`/api/portability/carry/apply`)
 * — разговор этого CLI садится как перенос к Claude: в списке (компьютер и телефон), открыт из
 * списка — ход в тот же сеанс ядра (новых задач 0).
 *
 * Запуск: `node tools/qa/check-core-chat-history.mjs [--foreign=qwen,opencode] [--claude=0]
 * [--handoff=qwen] [--carry=qwen]`.
 * `SHOTS=<dir>` — кадры в обеих темах, `SHOT_TAG=BEFORE|AFTER` — суффикс кадра.
 * Код выхода: 0 — сходится, 1 — провал, 2 — не проверено.
 */
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { chatScript } from './check-core-chat.mjs';

const arg = (name) => {
  const hit = process.argv.slice(2).find((a) => a.startsWith(`--${name}=`));
  return hit === undefined ? undefined : hit.slice(name.length + 3);
};
const FOREIGN = (arg('foreign') ?? 'qwen,opencode')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
const CLAUDE = arg('claude') !== '0';
const HANDOFF = (arg('handoff') ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
const CARRY = (arg('carry') ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
/** Слово предложения продолжения: по нему видно продолжение в ленте и в названии чата. */
const HANDOFF_MARK = 'передача-77';
const HANDOFF_ASK = 'передай работу';
const HANDOFF_DONE = 'Этап проверки закрыт';
/** Начало инициативы панели (`SOURCE_OPENER`): модели — да, в ленте человека — нет. */
const INITIATIVE_OPENER = 'This run was started from the AgentDeck panel';
const SHOTS = process.env.SHOTS || '';
const SHOT_TAG = process.env.SHOT_TAG || 'AFTER';
const ANSWER = 'готов';

const { chromium } = await import('playwright');
const { runOnStand, NotChecked, wait, freePort } = await import('./throwaway-stand.mjs');
const { startStubPlatform } = await import('./stub-platform.mjs');
const { openProjectChat, dismissAccess } = await import('./chat-walk.mjs');
const { startStubModel } = await import('../../packages/stub-model/src/index.mjs');

const cliAt = (name) => {
  const r = spawnSync(process.platform === 'win32' ? 'where' : 'which', [name], {
    encoding: 'utf8',
  });
  return r.status === 0 ? r.stdout.split(/\r?\n/)[0].trim() : '';
};
const found = Object.fromEntries(
  [...FOREIGN, ...HANDOFF, ...CARRY, 'claude'].map((cli) => [cli, cliAt(cli)]),
);
const extraPath = [
  ...new Set(
    Object.values(found)
      .filter(Boolean)
      .map((p) => dirname(p)),
  ),
];
const git = (cwd, args) => {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (r.status) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
};

let repo = '';
let notes = '';
/** Последние слова человека в запросе к модели (строкой или блоками текста). */
function lastHumanText(body) {
  const messages = Array.isArray(body?.messages) ? body.messages : [];
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m?.role !== 'user') continue;
    const text =
      typeof m.content === 'string'
        ? m.content
        : (Array.isArray(m.content) ? m.content : [])
            .filter((b) => b?.type === 'text')
            .map((b) => b.text)
            .join('\n');
    if (text.trim()) return text;
  }
  return '';
}
/** Ответ Claude с блоком продолжения — тот, по которому панель рисует карточку. */
const handoffAnswer = () =>
  [
    'Этап закрыт.',
    '',
    '```agentdeck:handoff',
    JSON.stringify({
      done: HANDOFF_DONE,
      next: `${HANDOFF_MARK}: продолжай по заметкам`,
      checkpoint: '.agent/PROGRESS.md',
    }),
    '```',
  ].join('\n');
const claudeStub = await startStubModel({
  script: (ctx) =>
    lastHumanText(ctx.request.body).includes(HANDOFF_ASK)
      ? { text: handoffAnswer() }
      : chatScript({ file: notes })(ctx),
});
const stubEnv = { ANTHROPIC_BASE_URL: claudeStub.baseUrl, ANTHROPIC_API_KEY: 'stand-stub-key' };
const contour = await startStubPlatform({ port: 0 });
const gatewayPort = await freePort();
const completions = () => contour.calls.filter((c) => c.path.endsWith('/chat/completions'));

async function shoot(page, name) {
  if (!SHOTS) return;
  mkdirSync(SHOTS, { recursive: true });
  for (const theme of ['light', 'dark']) {
    await page.evaluate((t) => {
      document.documentElement.dataset.theme = t;
      document.documentElement.style.colorScheme = t;
    }, theme);
    await page.waitForTimeout(250);
    await page.screenshot({ path: join(SHOTS, `${name}-${theme}_${SHOT_TAG}.png`) });
  }
  await page.evaluate(() => {
    document.documentElement.dataset.theme = 'light';
    document.documentElement.style.colorScheme = 'light';
  });
}

/** Задачи ядра стенда и сеансы задачи по её журналу. */
function coreTasks(stand) {
  try {
    return readdirSync(join(stand.coreHome, 'tasks'));
  } catch {
    return [];
  }
}
function sessionsOf(stand, taskId) {
  const dir = join(stand.coreHome, 'tasks', taskId);
  const name = readdirSync(dir).find((f) => f.endsWith('.jsonl'));
  return readFileSync(join(dir, name), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l))
    .filter((l) => l.kind === 'session.started')
    .map((l) => ({ sessionId: l.sessionId ?? l.data?.sessionId, adapter: l.data?.adapter }));
}
/** Хвост журнала задачи для провала: без него «3 задачи» не говорят, чем кончился каждый ход. */
function journalTail(stand, taskId, n = 6) {
  try {
    const dir = join(stand.coreHome, 'tasks', taskId);
    // `DUMP_CORE=<каталог>` — дом ядра стенда целиком туда (журналы, сеансы): стенд снимут после прогона.
    if (process.env.DUMP_CORE) {
      cpSync(stand.coreHome, process.env.DUMP_CORE, { recursive: true, force: true });
    }
    const name = readdirSync(dir).find((f) => f.endsWith('.jsonl'));
    return readFileSync(join(dir, name), 'utf8')
      .split('\n')
      .filter(Boolean)
      .slice(-n)
      .map((l) => {
        const e = JSON.parse(l);
        const why = e.data?.reason ?? e.data?.error ?? e.data?.code ?? e.data?.status ?? '';
        return `${e.kind}${why ? `(${String(typeof why === 'string' ? why : JSON.stringify(why)).slice(0, 160)})` : ''}`;
      })
      .join(' → ');
  } catch (error) {
    return `журнал не прочитан: ${error instanceof Error ? error.message : error}`;
  }
}

async function patchSettings(page, change) {
  for (let n = 1; ; n++) {
    await page.waitForLoadState('load');
    try {
      const status = await page.evaluate(async (body) => {
        const res = await fetch('/api/settings', {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        });
        return res.status;
      }, change);
      if (status !== 200) throw new Error(`настройки ${JSON.stringify(change)}: ${status}`);
      return;
    } catch (error) {
      if (n >= 3 || !/Failed to fetch|Execution context was destroyed/.test(String(error)))
        throw error;
      await wait(2000);
    }
  }
}

/**
 * Лента в порядке документа: слова человека (`[data-feed-message]` с «ист-N»/«ход-N») и ответы
 * (текстовые узлы, равные ответу). Ответ хода — узел между его словом и следующим словом.
 */
function feedOrder(page, wordRe, answers) {
  return page.evaluate(
    ({ re, answers: texts }) => {
      const word = new RegExp(re);
      const out = [];
      // Пузырь ответа («ответ на ход-61») тоже несёт слово хода — это ответ, а не слово человека.
      const bubbles = new Set(
        [...document.querySelectorAll('[data-feed-message]')].filter(
          (el) =>
            word.test(el.textContent ?? '') &&
            !texts.some((answer) => (el.textContent ?? '').includes(answer)),
        ),
      );
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT | 4);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        if (node.nodeType === 1 && bubbles.has(node)) {
          out.push(`U:${word.exec(node.textContent ?? '')?.[0]}`);
        } else if (node.nodeType === 3) {
          const t = node.textContent?.trim() ?? '';
          if (texts.includes(t) && !out.at(-1)?.startsWith('A')) out.push(`A:${t}`);
        }
      }
      return out;
    },
    { re: wordRe.source, answers },
  );
}

/** Каждое слово из `words` есть ровно раз и сразу за ним — ответ. */
function pairedAll(order, words) {
  const users = order.filter((x) => x.startsWith('U:'));
  if (users.length !== words.length) return false;
  return words.every((w, i) => {
    const at = order.indexOf(`U:${w}`);
    return at >= 0 && users[i] === `U:${w}` && order[at + 1]?.startsWith('A:');
  });
}

async function idle(page, seconds) {
  const stop = page.getByRole('button', { name: 'Остановить' });
  for (let i = 0; i < seconds * 4; i++) {
    if ((await stop.count()) === 0) return true;
    await wait(250);
  }
  return false;
}

/** Ход: слово уходит, ответ встаёт под ним, прогон кончается. */
async function turn(page, word, text, re, answers, seconds = 180) {
  const input = page.locator('textarea[data-chat-input]');
  await input.waitFor({ timeout: 60_000 });
  await input.fill(`${word}: ${text}`);
  await input.press('Enter');
  for (let i = 0; i < seconds; i++) {
    const order = await feedOrder(page, re, answers);
    const at = order.indexOf(`U:${word}`);
    if (at >= 0 && order[at + 1]?.startsWith('A:') && (await idle(page, 1))) break;
    await wait(1000);
  }
  // Конец прогона снимает живой пузырь — суд после него, с запасом на перечитку ленты.
  await idle(page, 60);
  await wait(3000);
  return feedOrder(page, re, answers);
}

const conversationOf = (page) => new URL(page.url()).searchParams.get('id') ?? '';

async function apiMessages(page, id) {
  return page.evaluate(async (chatId) => {
    const res = await fetch(`/api/chats/${encodeURIComponent(chatId)}/messages?limit=50`);
    if (!res.ok) return { status: res.status, roles: [] };
    const body = await res.json();
    return {
      status: res.status,
      roles: body.messages.map(
        (m) =>
          `${m.role}:${m.blocks
            .filter((b) => b.type === 'text')
            .map((b) => b.text)
            .join('')
            .slice(0, 40)}`,
      ),
    };
  }, id);
}

async function listed(page, id) {
  return page.evaluate(async (chatId) => {
    const res = await fetch('/api/chats');
    const chats = res.ok ? await res.json() : [];
    return chats.find((c) => c.id === chatId) ?? null;
  }, id);
}

/** Список проектов телефона (`/api/chats/projects`): строки разговора с этим id. */
async function phoneListed(page, id) {
  return page.evaluate(async (chatId) => {
    const res = await fetch('/api/chats/projects');
    const projects = res.ok ? await res.json() : [];
    return projects.flatMap((p) =>
      p.chats.filter((c) => c.id === chatId).map((c) => ({ ...c, path: p.path })),
    );
  }, id);
}

/**
 * Разговор чужого CLI идёт через контур по своей галочке `foreign:<cli>` (`chatConsumerOf`), «Чат»
 * ведёт только Claude: без неё ход qwen шёл бы своим входом CLI мимо заглушки.
 */
const ALL_CONSUMERS = [
  'chat',
  ...[...new Set([...FOREIGN, ...HANDOFF, ...CARRY])].map((cli) => `foreign:${cli}`),
];
async function activateContour(stand, check, consumers = ALL_CONSUMERS) {
  const CONTOUR = 'one-chat';
  const saved = await stand.api(`/platforms/${CONTOUR}`, {
    method: 'PUT',
    body: {
      settings: {
        id: CONTOUR,
        title: 'Контур чата',
        driver: 'enterprise-platform',
        baseUrl: contour.url,
        enabled: true,
        mode: 'best-effort',
        budgetUsd: 0,
        budgetSince: '',
        capabilities: [],
        consumers,
        targets: [],
        projectPaths: [],
        agents: [],
        caCertPath: '',
        toolShim: false,
        defaultModel: 'stub-chat',
        modelMap: {},
      },
      token: ['chat', 'stub', 'key'].join('-'),
    },
  });
  const activated = await stand.api(`/platforms/${CONTOUR}/activate?probe=skip`, {
    method: 'POST',
    body: {},
  });
  const restarted = await stand.api('/platforms/gateway/restart', { method: 'POST', body: {} });
  check(
    `контур стенда (${consumers.join(', ')}) сохранён, активен, шлюз на своём порту`,
    saved.status === 200 &&
      activated.body?.activePlatformId === CONTOUR &&
      restarted.body?.status?.running === true,
    JSON.stringify([saved.body, activated.body, restarted.body?.status]).slice(0, 500),
  );
}

/**
 * Шапка чата чужого CLI называет маршрут по ТОЙ ЖЕ галочке, что ведёт ход (`chatConsumerOf`):
 * при одной «Чат» ход qwen идёт мимо контура — шапка контура не обещает; с `foreign:<cli>` — обещает.
 * Прежде страница спрашивала план «Чата» у любого CLI и обещала контур ходу, ушедшему мимо него.
 */
async function headerPromise(stand, check, browser, cli) {
  const page = await openProjectChat(stand, browser, repo, 'repo');
  const promise = 'Через контур «Контур чата»';
  const shows = async () => {
    // План прогона приходит запросом: ждём, пока подпись встанет или точно не встанет.
    for (let i = 0; i < 20; i++) {
      if ((await page.getByText(promise).count()) > 0) return true;
      await wait(500);
    }
    return false;
  };
  try {
    await activateContour(stand, check, ['chat']);
    await patchSettings(page, { provider: cli });
    await page.reload();
    await dismissAccess(page);
    await page.getByRole('button', { name: 'Новый чат', exact: true }).first().click();
    const chatOnly = await shows();
    await shoot(page, `header-chat-only-${cli}`);
    check(
      `${cli} (шапка): при одной галочке «Чат» контур не обещан (подпись: ${chatOnly})`,
      !chatOnly,
    );
    await activateContour(stand, check);
    await page.reload();
    await dismissAccess(page);
    await page.getByRole('button', { name: 'Новый чат', exact: true }).first().click();
    const own = await shows();
    await shoot(page, `header-own-tick-${cli}`);
    check(`${cli} (шапка): с галочкой foreign:${cli} контур обещан (подпись: ${own})`, own);
  } finally {
    await page.close();
  }
}

/** Разговор чужого CLI: три хода, F5, список, открытие из списка и ход в тот же сеанс. */
async function foreignHistory(stand, check, browser, cli) {
  const page = await openProjectChat(stand, browser, repo, 'repo');
  const re = /ист-\d+/;
  const answers = [ANSWER];
  try {
    await patchSettings(page, { provider: cli });
    await page.reload();
    await dismissAccess(page);
    await page.getByRole('button', { name: 'Новый чат', exact: true }).first().click();
    await wait(1000);
    const before = coreTasks(stand);
    const words = ['ист-1', 'ист-2', 'ист-3'];
    const orders = [];
    for (const word of words) orders.push(await turn(page, word, `${cli} слово`, re, answers));
    const conv = conversationOf(page);
    const tasks = coreTasks(stand).filter((t) => !before.includes(t));
    const sessions = tasks.flatMap((t) => sessionsOf(stand, t));
    check(
      `${cli}: три хода — одна задача ядра с сеансом ${cli} (${tasks.length} задач, ${sessions.length} сеансов)`,
      tasks.length === 1 && sessions.length >= 1 && sessions.every((s) => s.adapter === cli),
      [JSON.stringify(sessions), ...tasks.map((t) => `${t}: ${journalTail(stand, t)}`)].join(
        '\n    ',
      ),
    );
    check(
      `${cli} (a): после каждого хода все прежние ответы на месте (${orders.map((o) => o.join(' ')).join(' | ')})`,
      orders.every((o, i) => pairedAll(o, words.slice(0, i + 1))),
    );
    await shoot(page, `foreign-history-${cli}-live`);

    await page.reload();
    await dismissAccess(page);
    let reloaded = [];
    for (let i = 0; i < 30 && !pairedAll(reloaded, words); i++) {
      reloaded = await feedOrder(page, re, answers);
      if (!pairedAll(reloaded, words)) await wait(1000);
    }
    const api = await apiMessages(page, conv);
    check(
      `${cli} (b): после F5 те же три хода с ответами (лента: ${reloaded.join(' ')}; API ${api.status}: ${api.roles.join(' · ')})`,
      pairedAll(reloaded, words) &&
        api.roles.filter((r) => r.startsWith('assistant:')).length === 3 &&
        api.roles.filter((r) => r.startsWith('user:')).length === 3,
    );
    await shoot(page, `foreign-history-${cli}-reload`);

    const summary = await listed(page, conv);
    const row = page.locator(`[data-chat-pin="${conv}"]`);
    const rowShown = await row
      .first()
      .waitFor({ state: 'attached', timeout: 20_000 })
      .then(() => true)
      .catch(() => false);
    check(
      `${cli} (c): чат в списке (/api/chats: ${summary ? `«${summary.title}», ${summary.messageCount} реплик, ${summary.projectPath}` : 'нет'}; строка в боковой панели: ${rowShown})`,
      Boolean(summary) &&
        rowShown &&
        summary.messageCount === 6 &&
        String(summary.title).includes('ист-1'),
    );
    const phone = await phoneListed(page, conv);
    check(
      `${cli} (c, телефон): чат в списке проектов (/api/chats/projects: ${phone.map((c) => `«${c.title}», ${c.messageCount} реплик, ${c.path}`).join('; ') || 'нет'})`,
      phone.length === 1 && phone[0].messageCount === 6,
    );

    // Открыть заново из списка: другой (новый) чат, потом строка разговора.
    await page.getByRole('button', { name: 'Новый чат', exact: true }).first().click();
    await wait(1500);
    const clean = await feedOrder(page, re, answers);
    // Строка разговора — кнопка рядом с булавкой (`ChatRow`): первая кнопка их общей обёртки.
    if (rowShown) await row.first().locator('xpath=..').locator('button').first().click();
    let reopened = [];
    for (let i = 0; i < 30 && !pairedAll(reopened, words); i++) {
      reopened = await feedOrder(page, re, answers);
      if (!pairedAll(reopened, words)) await wait(1000);
    }
    check(
      `${cli}: открыт заново из списка — та же история (пустой чат до: ${clean.length}; после: ${reopened.join(' ')}; id ${conversationOf(page) === conv})`,
      clean.length === 0 && conversationOf(page) === conv && pairedAll(reopened, words),
    );
    const tasksBefore4 = coreTasks(stand);
    const calls4 = completions().length;
    const order4 = await turn(page, 'ист-4', `${cli} после открытия`, re, answers);
    const fresh4 = coreTasks(stand).filter((t) => !tasksBefore4.includes(t));
    const sessions4 = tasks.flatMap((t) => sessionsOf(stand, t));
    const asked = completions()
      .slice(calls4)
      .map((c) => String(c.body ?? ''));
    const sawHistory = asked.some((b) => b.includes('ист-1') && b.includes('ист-4'));
    check(
      `${cli}: новый ход после открытия — тот же сеанс ядра (новых задач ${fresh4.length}, сеансов ${sessions.length} → ${sessions4.length}, контур видит ист-1 рядом с ист-4: ${sawHistory})`,
      fresh4.length === 0 &&
        sessions4.length === sessions.length &&
        sawHistory &&
        pairedAll(order4, [...words, 'ист-4']),
      order4.join(' '),
    );
    await shoot(page, `foreign-history-${cli}-reopened`);
  } finally {
    await patchSettings(page, { provider: 'claude' }).catch(() => undefined);
    await page.close();
  }
}

/** Реплики разговора по API целиком: роль и весь текст (у продолжения слово стоит не в начале). */
async function apiTexts(page, id) {
  return page.evaluate(async (chatId) => {
    const res = await fetch(`/api/chats/${encodeURIComponent(chatId)}/messages?limit=50`);
    if (!res.ok) return { status: res.status, messages: [] };
    const body = await res.json();
    return {
      status: res.status,
      messages: body.messages.map((m) => ({
        role: m.role,
        text: m.blocks
          .filter((b) => b.type === 'text')
          .map((b) => b.text)
          .join(''),
      })),
    };
  }, id);
}

async function visible(page, text, seconds) {
  for (let i = 0; i < seconds; i++) {
    if ((await page.getByText(text).count()) > 0) return true;
    await wait(1000);
  }
  return false;
}

/**
 * Продолжение в чистой сессии к чужому CLI: чат Claude предлагает продолжение (ход Claude — ДО
 * контура: блок даёт заглушка claude), человек переключает CLI и жмёт «Продолжить в новом чате».
 * Разговор продолжения садится как у Claude: в списке, после F5, открыт из списка — тот же сеанс.
 */
async function foreignHandoff(stand, check, browser, cli, contourUp) {
  const page = await openProjectChat(stand, browser, repo, 'repo');
  const apply = page.getByRole('button', { name: 'Продолжить в новом чате' });
  const tag = `продолжение → ${cli}`;
  try {
    await patchSettings(page, { provider: 'claude' });
    await page.getByRole('button', { name: 'Новый чат', exact: true }).first().click();
    await wait(1000);
    const input = page.locator('textarea[data-chat-input]');
    await input.waitFor({ timeout: 60_000 });
    await input.fill(`ход-71: ${HANDOFF_ASK}`);
    await input.press('Enter');
    const card = await apply
      .first()
      .waitFor({ timeout: 180_000 })
      .then(() => true)
      .catch(() => false);
    await idle(page, 60);
    const source = conversationOf(page);
    check(`${tag}: Claude предложил продолжение — карточка на месте (чат ${source})`, card);
    if (!card) return;

    await contourUp();
    await patchSettings(page, { provider: cli });
    const tasksBefore = coreTasks(stand);
    const replied = page.waitForResponse(
      (r) => r.url().endsWith('/api/chat/handoff') && r.request().method() === 'POST',
      { timeout: 30_000 },
    );
    await apply.first().click();
    const res = await replied;
    const body = await res.json().catch(() => ({}));
    let answered = false;
    for (let i = 0; i < 180 && !answered; i++) {
      answered = (await page.getByText(ANSWER, { exact: true }).count()) > 0;
      if (!answered) await wait(1000);
    }
    await idle(page, 60);
    // Временный ключ `new-…` вкладка меняет на id разговора, когда прогон его назовёт.
    let conv = conversationOf(page);
    for (let i = 0; i < 30 && (!conv || conv.startsWith('new-')); i++) {
      await wait(1000);
      conv = conversationOf(page);
    }
    const tasks = coreTasks(stand).filter((t) => !tasksBefore.includes(t));
    const sessions = tasks.flatMap((t) => sessionsOf(stand, t));
    check(
      `${tag}: заведено (ответ ${res.status()}, ${JSON.stringify({ chatId: body.chatId, started: body.started })}); задач ядра ${tasks.length}, сеансы ${JSON.stringify(sessions)}; ответ в ленте ${answered}; id вкладки ${conv}`,
      res.status() === 200 &&
        body.started === true &&
        tasks.length === 1 &&
        sessions.length >= 1 &&
        sessions.every((s) => s.adapter === cli) &&
        answered &&
        Boolean(conv) &&
        !conv.startsWith('new-') &&
        conv !== source,
    );

    await page.reload();
    await dismissAccess(page);
    const shownMark = await visible(page, HANDOFF_MARK, 30);
    const shownAnswer = (await page.getByText(ANSWER, { exact: true }).count()) > 0;
    const api = await apiTexts(page, conv);
    const users = api.messages.filter((m) => m.role === 'user');
    check(
      `${tag} (F5): лента на месте (слово ${shownMark}, ответ ${shownAnswer}, id ${conversationOf(page) === conv}); API ${api.status}: ${api.messages.map((m) => `${m.role}:${m.text.length}`).join(' · ')}`,
      shownMark &&
        shownAnswer &&
        conversationOf(page) === conv &&
        users.length === 1 &&
        users[0].text.includes(HANDOFF_MARK) &&
        api.messages.some((m) => m.role === 'assistant' && m.text.includes(ANSWER)),
    );
    // Инициатива панели уходит чужому CLI текстом задания, но в ленте её нет — как у Claude,
    // где она системная подсказка. В видимой ленте — тоже.
    const bubble = await visible(page, INITIATIVE_OPENER, 3);
    check(
      `${tag} (F5): первая реплика без инициативы панели (API ${!users[0]?.text.includes(INITIATIVE_OPENER)}, на странице ${!bubble})`,
      users.length === 1 && !users[0].text.includes(INITIATIVE_OPENER) && !bubble,
    );
    await page
      .getByText(HANDOFF_DONE)
      .first()
      .scrollIntoViewIfNeeded()
      .catch(() => undefined);
    await shoot(page, `handoff-${cli}-feed`);

    const summary = conv ? await listed(page, conv) : null;
    const row = page.locator(`[data-chat-pin="${conv}"]`);
    const rowShown = await row
      .first()
      .waitFor({ state: 'attached', timeout: 20_000 })
      .then(() => true)
      .catch(() => false);
    check(
      `${tag} (список): /api/chats ${summary ? `«${summary.title}», ${summary.messageCount} реплик` : 'нет'}; строка в боковой панели ${rowShown}`,
      Boolean(summary) &&
        rowShown &&
        summary.messageCount === 2 &&
        String(summary.title).startsWith(HANDOFF_MARK) &&
        // Инициатива панели — хвост задания: в название, как у Claude, не попадает.
        !String(summary.title).includes('This run was started'),
    );
    const phone = conv ? await phoneListed(page, conv) : [];
    check(
      `${tag} (список телефона): /api/chats/projects ${phone.map((c) => `«${c.title}», ${c.messageCount} реплик`).join('; ') || 'нет'}`,
      phone.length === 1 &&
        phone[0].messageCount === 2 &&
        !String(phone[0].title).includes('This run was started'),
    );
    await shoot(page, `handoff-${cli}-list`);

    // Открыть заново из списка: другой (новый) чат, потом строка продолжения.
    await page.getByRole('button', { name: 'Новый чат', exact: true }).first().click();
    await wait(1500);
    if (rowShown) await row.first().locator('xpath=..').locator('button').first().click();
    const reopened = rowShown && (await visible(page, HANDOFF_MARK, 30));
    check(
      `${tag}: открыт из списка — та же лента (слово ${reopened}, id ${conversationOf(page) === conv})`,
      reopened && conversationOf(page) === conv,
    );
    if (!reopened) return;
    const tasksBefore9 = coreTasks(stand);
    const order9 = await turn(page, 'ист-9', `${cli} после передачи`, /ист-\d+/, [ANSWER]);
    const fresh9 = coreTasks(stand).filter((t) => !tasksBefore9.includes(t));
    const sessions9 = tasks.flatMap((t) => sessionsOf(stand, t));
    check(
      `${tag}: ход после открытия — тот же сеанс ядра (новых задач ${fresh9.length}, сеансов ${sessions.length} → ${sessions9.length}; ${order9.join(' ')})`,
      fresh9.length === 0 && sessions9.length === sessions.length && pairedAll(order9, ['ист-9']),
    );
    await shoot(page, `handoff-${cli}-reopened`);
  } finally {
    await patchSettings(page, { provider: 'claude' }).catch(() => undefined);
    await page.close();
  }
}

/**
 * Перенос к чужому CLI: разговор Claude (ход до контура, ответ — заглушка claude) с опорой на диске,
 * активный CLI переключён, перенос по ключу разговора. Новый разговор садится как у Claude: в списке
 * (компьютер и телефон), открыт из списка — лента с ответом, ход в тот же сеанс ядра.
 */
async function foreignCarry(stand, check, browser, cli, contourUp) {
  const page = await openProjectChat(stand, browser, repo, 'repo');
  const tag = `перенос → ${cli}`;
  try {
    await patchSettings(page, { provider: 'claude' });
    await page.getByRole('button', { name: 'Новый чат', exact: true }).first().click();
    await wait(1000);
    await turn(page, 'ход-81', 'переименуй заметки', /ход-\d+/, ['ответ на ход-81']);
    const source = conversationOf(page);
    mkdirSync(join(repo, '.agent'), { recursive: true });
    writeFileSync(join(repo, '.agent', 'PROGRESS.md'), 'Перенос: заметки ещё не переименованы.\n');

    await contourUp();
    await patchSettings(page, { provider: cli });
    const chatIds = async () =>
      page.evaluate(async () => {
        const res = await fetch('/api/chats');
        return res.ok ? (await res.json()).map((c) => c.id) : [];
      });
    const before = new Set(await chatIds());
    const tasksBefore = coreTasks(stand);
    const carried = await page.evaluate(async (key) => {
      const res = await fetch('/api/portability/carry/apply', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ keys: [key] }),
      });
      return { status: res.status, body: await res.json().catch(() => ({})) };
    }, source);
    const outcome = carried.body?.outcomes?.[0] ?? {};
    // Ключ `new-…` прогон меняет на id сеанса ядра — новый id в списке и есть перенесённый разговор.
    let conv = '';
    for (let i = 0; i < 180 && !conv; i++) {
      conv = (await chatIds()).find((id) => !before.has(id) && id !== source) ?? '';
      if (!conv) await wait(1000);
    }
    const tasks = coreTasks(stand).filter((t) => !tasksBefore.includes(t));
    const sessions = tasks.flatMap((t) => sessionsOf(stand, t));
    check(
      `${tag}: заведено (ответ ${carried.status}, ${JSON.stringify(outcome)}); задач ядра ${tasks.length}, сеансы ${JSON.stringify(sessions)}; разговор в списке ${conv || 'нет'}`,
      carried.status === 200 &&
        outcome.carried === true &&
        String(outcome.chatId).startsWith('new-') &&
        tasks.length === 1 &&
        sessions.length >= 1 &&
        sessions.every((s) => s.adapter === cli) &&
        Boolean(conv) &&
        !conv.startsWith('new-'),
    );
    if (!conv) return;
    let api = { status: 0, messages: [] };
    for (let i = 0; i < 60 && !api.messages.some((m) => m.role === 'assistant'); i++) {
      api = await apiTexts(page, conv);
      if (!api.messages.some((m) => m.role === 'assistant')) await wait(1000);
    }
    const first = api.messages.find((m) => m.role === 'user')?.text ?? '';
    const summary = await listed(page, conv);
    const phone = await phoneListed(page, conv);
    check(
      `${tag} (список): /api/chats ${summary ? `«${summary.title}», ${summary.messageCount} реплик` : 'нет'}; телефон ${phone.map((c) => `«${c.title}», ${c.messageCount}`).join('; ') || 'нет'}; первая реплика: опора ${first.includes('PROGRESS.md')}, задание ${first.includes('ход-81')}, инициатива ${first.includes(INITIATIVE_OPENER)}`,
      Boolean(summary) &&
        summary.projectPath === repo &&
        summary.messageCount === 2 &&
        phone.length === 1 &&
        phone[0].messageCount === 2 &&
        !String(summary.title).includes(INITIATIVE_OPENER) &&
        first.includes('PROGRESS.md') &&
        first.includes('ход-81') &&
        !first.includes(INITIATIVE_OPENER),
    );

    await page.reload();
    await dismissAccess(page);
    const row = page.locator(`[data-chat-pin="${conv}"]`);
    const rowShown = await row
      .first()
      .waitFor({ state: 'attached', timeout: 20_000 })
      .then(() => true)
      .catch(() => false);
    await shoot(page, `carry-${cli}-list`);
    await page.getByRole('button', { name: 'Новый чат', exact: true }).first().click();
    await wait(1500);
    if (rowShown) await row.first().locator('xpath=..').locator('button').first().click();
    const reopened = rowShown && (await visible(page, ANSWER, 30));
    const bubble = await visible(page, INITIATIVE_OPENER, 3);
    check(
      `${tag}: открыт из списка — та же лента (строка ${rowShown}, ответ ${reopened}, id ${conversationOf(page) === conv}, инициатива на странице ${bubble})`,
      reopened && conversationOf(page) === conv && !bubble,
    );
    if (!reopened) return;
    const tasksBefore10 = coreTasks(stand);
    const order10 = await turn(page, 'ист-10', `${cli} после переноса`, /ист-\d+/, [ANSWER]);
    const fresh10 = coreTasks(stand).filter((t) => !tasksBefore10.includes(t));
    const sessions10 = tasks.flatMap((t) => sessionsOf(stand, t));
    check(
      `${tag}: ход после открытия — тот же сеанс ядра (новых задач ${fresh10.length}, сеансов ${sessions.length} → ${sessions10.length}; ${order10.join(' ')})`,
      fresh10.length === 0 &&
        sessions10.length === sessions.length &&
        pairedAll(order10, ['ист-10']),
    );
    await shoot(page, `carry-${cli}-reopened`);
  } finally {
    await patchSettings(page, { provider: 'claude' }).catch(() => undefined);
    await page.close();
  }
}

/** Разговор claude (без контура не идёт — контур «Чат» трогает и его; ответ — заглушка claude). */
async function claudeHistory(stand, check, browser) {
  const page = await openProjectChat(stand, browser, repo, 'repo');
  const re = /ход-\d+/;
  const answers = ['ответ на ход-61', 'ответ на ход-62'];
  try {
    await patchSettings(page, { provider: 'claude' });
    await page.getByRole('button', { name: 'Новый чат', exact: true }).first().click();
    await wait(1000);
    const o1 = await turn(page, 'ход-61', 'claude', re, answers);
    const o2 = await turn(page, 'ход-62', 'claude', re, answers);
    const conv = conversationOf(page);
    await page.reload();
    await dismissAccess(page);
    let reloaded = [];
    for (let i = 0; i < 30 && !pairedAll(reloaded, ['ход-61', 'ход-62']); i++) {
      reloaded = await feedOrder(page, re, answers);
      if (!pairedAll(reloaded, ['ход-61', 'ход-62'])) await wait(1000);
    }
    const summary = await listed(page, conv);
    const transcript = summary?.project
      ? existsSync(join(stand.cfg, 'projects', summary.project, `${conv}.jsonl`))
      : false;
    check(
      `claude: два хода в ленте, после F5 из транскрипта, в списке (живьём ${o1.join(' ')} / ${o2.join(' ')}; F5 ${reloaded.join(' ')}; транскрипт ${transcript})`,
      pairedAll(o2, ['ход-61', 'ход-62']) &&
        pairedAll(reloaded, ['ход-61', 'ход-62']) &&
        transcript &&
        summary?.messageCount >= 4,
    );
    await shoot(page, 'foreign-history-claude-reload');
  } finally {
    await page.close();
  }
}

await runOnStand(
  {
    label: 'core-chat-history',
    extraPath,
    env: stubEnv,
    core: true,
    settings: { platformGateway: { enabled: true, port: gatewayPort, forceStream: true } },
    seed: ({ root }) => {
      repo = join(root, 'repo');
      notes = join(repo, 'notes.txt');
      mkdirSync(repo, { recursive: true });
      git(repo, ['init', '-q', '-b', 'main']);
      git(repo, ['config', 'user.name', 'stand']);
      git(repo, ['config', 'user.email', 'stand@example.invalid']);
      writeFileSync(notes, 'заметки\n');
      git(repo, ['add', '.']);
      git(repo, ['commit', '-qm', 'init']);
    },
  },
  async (stand, check) => {
    const browser = await chromium.launch();
    try {
      if (!found.claude)
        throw new NotChecked('claude нет в PATH — чат /chat через ядро не проверен');
      const settingsPath = join(stand.cfg, 'settings.json');
      const settings = existsSync(settingsPath)
        ? JSON.parse(readFileSync(settingsPath, 'utf8'))
        : {};
      writeFileSync(
        settingsPath,
        `${JSON.stringify({ ...settings, env: { ...settings.env, ...stubEnv } }, null, 2)}\n`,
      );
      const part = (name, run) =>
        run().catch((error) =>
          check(`${name}: сценарий дошёл до конца`, false, error?.stack ?? String(error)),
        );
      if (CLAUDE) await part('claude', () => claudeHistory(stand, check, browser));
      // Контур — один раз: продолжению после хода Claude (его блок даёт заглушка claude), иначе сразу.
      let contourOn = false;
      const contourUp = async () => {
        if (contourOn) return;
        contourOn = true;
        await activateContour(stand, check);
      };
      for (const cli of HANDOFF) {
        if (!found[cli]) {
          console.log(`  ~ ${cli} не найден в PATH — продолжение не проверено`);
          continue;
        }
        await part(`продолжение → ${cli}`, () =>
          foreignHandoff(stand, check, browser, cli, contourUp),
        );
      }
      for (const cli of CARRY) {
        if (!found[cli]) {
          console.log(`  ~ ${cli} не найден в PATH — перенос не проверен`);
          continue;
        }
        await part(`перенос → ${cli}`, () => foreignCarry(stand, check, browser, cli, contourUp));
      }
      const headerCli = FOREIGN.find((cli) => found[cli]);
      if (headerCli) {
        await part(`шапка ${headerCli}`, () => headerPromise(stand, check, browser, headerCli));
      }
      await part('контур', contourUp);
      for (const cli of FOREIGN) {
        if (!found[cli]) {
          console.log(`  ~ ${cli} не найден в PATH — не проверено`);
          continue;
        }
        await part(cli, () => foreignHistory(stand, check, browser, cli));
      }
    } finally {
      await browser.close();
      await claudeStub.close();
      await contour.close();
    }
  },
);
