/**
 * Сторож групп разделения (фаза 2, W) на одноразовой панели — весь путь:
 * поток прогона группы → реестр → сторож → запись группы → API дерева →
 * карточка в хабе, и сигнал в Telegram.
 *
 * Подменены только внешние края: модель (фальшивый `claude` на PATH проигрывает
 * записанный поток stream-json) и сервер Telegram (заглушка по
 * `AGENTDECK_TELEGRAM_API`). Сам прогон идёт настоящим `POST /api/chat/send`
 * в чат группы, связь чата со звеном и запись разделения лежат в state.json
 * так, как их кладёт конвейер.
 *
 * Ход 1 группы в стадии работы: одна и та же проверка дважды без правки, два
 * сжатия подряд, скилл deep-review. Порог R4 снижен до 2 через PATCH настроек —
 * сторож читает пороги на ходу. Заводской порог R4 — 3 (рамка, его держит
 * `rules.test.ts`); 2 здесь ставится ЯВНО, чтобы ход был короче. Ожидается:
 *   - на записи группы активны R3 (шторм сжатий), R4 (проверка по кругу),
 *     R5 (ревью в работе) с числами;
 *   - в Telegram ушли ровно три сообщения «внимание» — по одному на правило, с
 *     проектом (сигнал сторожа — событие подписки `groupSignal`);
 *   - в хабе родителя у карточки группы остров сигналов и фишка «3» в сводке.
 * Ход 2: правка файла → R4 закрыт (clearedAt), R3 и R5 держатся.
 * Свежая группа: чат второй группы заведён под временным ключом `new-…`, как
 * его заводит разделение; первый ход рождает сессию. Сигнал R5 этого хода
 * живёт под настоящим id разговора, а не под `new-…`, и уходит в Telegram один;
 * окно её первого запроса 110k — R19 (сведения; продолжение без R19 держит
 * `group-watcher.test.ts`: у хода 1 здесь нет расхода, строка была бы зелёной всегда).
 * Пустой список событий: подписку снимают, новые сигналы встают на запись
 * группы — R3, R15 (команда убита по сроку, строки CLI 2.1.286), R14 (ответ
 * 25k знаков), R18 (пять отказов стража), — а в Telegram не уходит ничего.
 *
 * Запуск: node tools/qa/check-group-watch.mjs   (браузеры: pnpm qa:setup)
 */
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { basename, join } from 'node:path';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { chromium } from 'playwright';
import { freePort, runOnStand, wait } from './throwaway-stand.mjs';

const PARENT = 'qa-watch-parent';
const SESSION = '5e551000-0000-4000-8000-0000000000c7';
const PROJECT_NAME = 'qa-watch-app';
const CHECK = 'npx vitest run src/sum.test.ts';
/** Вторая группа: временный ключ чата до первого хода и сессия, которую ход рождает. */
const NEW_KEY = `new-${Date.now()}-1`;
const FRESH = '5e551000-0000-4000-8000-0000000000f1';

/** Фальшивый `claude`: ход по метке в реплике проигрывает записанный поток. */
const FAKE_CLAUDE = String.raw`
import { appendFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
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
let session = after('--resume') ?? after('--session-id') ?? ${JSON.stringify(SESSION)};
const out = (event) => process.stdout.write(JSON.stringify({ ...event, session_id: session }) + '\n');
let n = 0;
// more: usage — расход вызова; isError — блок ошибки; line(id) — верхние поля строки результата,
// как их пишет CLI 2.1.286 (tool_use_result, tool_result_meta).
const tool = (name, input, result, more = {}) => {
  n += 1;
  const id = 'toolu_qa_' + n;
  out({ type: 'assistant', message: { id: 'msg_qa_' + n, role: 'assistant', model: 'claude-opus-5', content: [{ type: 'tool_use', id, name, input }], ...(more.usage ? { usage: more.usage } : {}) } });
  out({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: result, ...(more.isError ? { is_error: true } : {}) }] }, ...(more.line ? more.line(id) : {}) });
};
const GUARD = "PreToolUse:Bash hook error: [ctx-guard] cmd-duration: this command took ~4 s here but the call's timeout is 3 s";
const compact = () => out({ type: 'system', subtype: 'compact_boundary', compact_metadata: { trigger: 'auto', pre_tokens: 180000 } });

function turn(text) {
  // Первый ход свежей группы: без --resume, сессию рождает сам CLI.
  if (text.includes('QA_WATCH_FRESH') && !after('--resume')) session = ${JSON.stringify(FRESH)};
  appendFileSync(LOG, JSON.stringify({ cwd: process.cwd(), session, text: text.slice(0, 200), at: Date.now() }) + '\n');
  out({ type: 'system', subtype: 'init', cwd: process.cwd(), model: 'claude-opus-5', tools: [] });
  if (text.includes('QA_WATCH_1')) {
    tool('Bash', { command: ${JSON.stringify(CHECK)} }, '1 failed');
    tool('Bash', { command: ${JSON.stringify(CHECK)} }, '1 failed');
    compact();
    compact();
    tool('Skill', { skill: 'deep-review' }, 'Launching skill: deep-review');
  }
  if (text.includes('QA_WATCH_2')) {
    tool('Edit', { file_path: join(process.cwd(), 'src', 'sum.ts'), old_string: 'a - b', new_string: 'a + b' }, 'ok');
  }
  if (text.includes('QA_WATCH_FRESH_1')) {
    // Первый запрос нового разговора — окно 110k (R19).
    tool('Skill', { skill: 'deep-review' }, 'Launching skill: deep-review', {
      usage: { input_tokens: 10, cache_creation_input_tokens: 110000, cache_read_input_tokens: 0, output_tokens: 20 },
    });
  }
  if (text.includes('QA_WATCH_FRESH_2')) {
    compact();
    compact();
    // Упор в срок: -p убивает команду (код 143) — R15.
    const killed = 'Exit code 143\nCommand timed out after 10m';
    tool('Bash', { command: 'pnpm test', timeout: 600000 }, killed, {
      isError: true,
      line: () => ({ tool_use_result: 'Error: ' + killed }),
    });
    // Огромный ответ инструмента в окно — R14.
    tool('Read', { file_path: join(process.cwd(), 'src', 'big.log') }, 'x'.repeat(25000));
    // Стена стража: пять отказов подряд — R18.
    for (let i = 0; i < 5; i++) {
      tool('Bash', { command: 'sleep 4', timeout: 3000 }, GUARD, {
        isError: true,
        line: (id) => ({ tool_use_result: 'Error: ' + GUARD, tool_result_meta: [{ id, non_execution_kind: 'permission-rule' }] }),
      });
    }
  }
  const reply = 'Done.';
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

// ---- заглушка Telegram ---------------------------------------------------------------------------
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
/** Каталог транскриптов копии: фальшивый CLI их не пишет, ход-продолжение ищет файл сессии. */
let transcripts = '';
const transcriptLine = (session, type, content) =>
  JSON.stringify({ type, sessionId: session, cwd: copy, message: { role: type, content } });

try {
  await runOnStand(
    {
      label: 'group-watch',
      fakeCli: { claude: FAKE_CLAUDE },
      env: { AGENTDECK_TELEGRAM_API: `http://127.0.0.1:${tgPort}` },
      seed: ({ root, cfg }) => {
        copy = join(root, PROJECT_NAME);
        mkdirSync(join(copy, 'src'), { recursive: true });
        writeFileSync(join(copy, 'src', 'sum.ts'), 'export const sum = (a, b) => a - b;\n');
        const git = (...args) => execFileSync('git', args, { cwd: copy, stdio: 'pipe' });
        git('init', '-q', '-b', 'feature/sum');
        git('add', '.');
        git('-c', 'user.name=qa', '-c', 'user.email=qa@example.com', 'commit', '-q', '-m', 'init');

        // Транскрипт сессии группы: прогон продолжает её, как продолжил бы конвейер.
        transcripts = join(cfg, 'projects', copy.replace(/[^a-zA-Z0-9]/g, '-'));
        mkdirSync(transcripts, { recursive: true });
        const line = (type, content) => transcriptLine(SESSION, type, content);
        writeFileSync(
          join(transcripts, `${SESSION}.jsonl`),
          `${line('user', 'PROJ-1 Сложение')}\n${line('assistant', [{ type: 'text', text: 'Начинаю.' }])}\n`,
        );

        const createdAt = new Date(Date.now() - 5 * 60_000).toISOString();
        const plan = {
          parentChatId: PARENT,
          projectPath: copy,
          createdAt,
          order: [0, 1],
          request: {},
          proposal: {
            groups: [
              { title: 'Сложение', branch: 'feature/sum', tasks: ['PROJ-1 Сложение'] },
              { title: 'Вычитание', branch: 'feature/sub', tasks: ['PROJ-2 Вычитание'] },
            ],
          },
          groups: [
            {
              index: 0,
              title: 'Сложение',
              branch: 'feature/sum',
              after: [],
              status: 'started',
              chatId: SESSION,
              path: copy,
              startedAt: createdAt,
            },
            // Свежая группа: чат заведён, первого хода ещё не было — ключ временный.
            {
              index: 1,
              title: 'Вычитание',
              branch: 'feature/sub',
              after: [],
              status: 'started',
              chatId: NEW_KEY,
              path: copy,
              startedAt: createdAt,
            },
          ],
        };
        const link = {
          parentChatId: PARENT,
          title: 'Сложение',
          branch: 'feature/sum',
          groupIndex: 0,
          stage: 'work',
          conversation: SESSION,
          createdAt,
        };
        const freshLink = {
          ...link,
          title: 'Вычитание',
          branch: 'feature/sub',
          groupIndex: 1,
          conversation: NEW_KEY,
        };
        const file = join(cfg, 'agentdeck', 'state.json');
        const state = JSON.parse(readFileSync(file, 'utf8'));
        writeFileSync(
          file,
          `${JSON.stringify({
            ...state,
            splitPlans: { [PARENT]: plan },
            chatLinks: { [SESSION]: link, [NEW_KEY]: freshLink },
          })}\n`,
        );
      },
    },
    async (stand, check) => {
      const calls = () => {
        const file = join(stand.bin, 'calls.jsonl');
        return existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean) : [];
      };
      const group = async (index = 0) =>
        (await stand.api(`/chat/${PARENT}/tree`)).body?.split?.groups?.[index];
      const signals = async (index = 0) => (await group(index))?.watchSignals ?? [];
      const active = (list, rule) => list.find((one) => one.rule === rule && !one.clearedAt);
      const send = async (prompt) =>
        stand.api('/chat/send', {
          method: 'POST',
          body: { chatId: SESSION, sessionId: SESSION, prompt, projectPath: copy },
        });

      // Пороги на ходу: проверка «по кругу» — со второго запуска.
      const patched = await stand.api('/settings', {
        method: 'PATCH',
        body: { groupWatch: { checkRepeats: 2 } },
      });
      check(
        'порог R4 снижен через PATCH настроек',
        patched.status === 200,
        patched.text.slice(0, 200),
      );
      const tgSaved = await stand.api('/integrations/telegram', {
        method: 'PUT',
        body: {
          settings: { enabled: true, chatId: '@qa-watch', events: ['groupSignal'] },
          token: '123:qa',
        },
      });
      check(
        'Telegram включён, подписка — только сигналы сторожа',
        tgSaved.status === 200,
        tgSaved.text.slice(0, 200),
      );

      // ------------------------------------------------------------------ ход 1
      const first = await send('QA_WATCH_1 продолжай работу группы');
      check('ход 1 принят', first.status === 200, first.text.slice(0, 300));
      let list = [];
      for (let t = 0; t < 30_000; t += 500) {
        await wait(500);
        list = await signals();
        if (calls().length >= 1 && ['R3', 'R4', 'R5'].every((rule) => active(list, rule))) break;
      }
      check(
        'фальшивый CLI отыграл ход 1 в копии группы',
        calls().length >= 1,
        String(calls().length),
      );
      const r3 = active(list, 'R3');
      const r4 = active(list, 'R4');
      const r5 = active(list, 'R5');
      check(
        'R3: два сжатия подряд — шторм на записи группы',
        r3?.numbers?.count === 2 && r3.severity === 'warn' && r3.chatId === SESSION,
        JSON.stringify(r3),
      );
      check(
        'R4: проверка дважды без правки при пороге 2 — с командой',
        r4?.numbers?.runs === 2 && r4.params?.command === CHECK,
        JSON.stringify(r4),
      );
      check(
        'R5: deep-review в стадии работы',
        r5?.stage === 'work' && r5.params?.description === 'deep-review',
        JSON.stringify(r5),
      );

      // Telegram: «внимание» уходит, отправка асинхронная — подождать.
      for (let t = 0; t < 10_000 && telegram.length < 3; t += 250) await wait(250);
      // Отправка асинхронна: лишняя (повтор без задержки) пришла бы чуть позже.
      await wait(2_000);
      const texts = telegram.map((one) => String(one.body?.text ?? ''));
      const perRule = (rule) => texts.filter((text) => text.includes(` ${rule} `)).length;
      check(
        'в Telegram ушли ровно три сообщения — R3, R4 и R5 по одному, адресату и через бота заглушки',
        telegram.length === 3 &&
          ['R3', 'R4', 'R5'].every((rule) => perRule(rule) === 1) &&
          telegram.every(
            (one) =>
              one.body?.chat_id === '@qa-watch' && one.path.startsWith('/bot123:qa/sendMessage'),
          ),
        JSON.stringify(telegram).slice(0, 600),
      );
      check(
        'текст сигнала называет проект',
        texts.length > 0 && texts.every((text) => text.includes(basename(copy))),
        texts.join(' | '),
      );
      const r4Text = texts.find((text) => text.includes(' R4 ')) ?? '';
      console.log(`     Telegram R4: ${r4Text}`);

      // ------------------------------------------------------------------ хаб
      /** Хаб родителя в браузере: список чатов подменён, дерево с сигналами — настоящее. */
      const openHub = async (browser) => {
        const page = await stand.newPage(browser, { height: 1100 });
        const chat = (id, extra) => ({
          id,
          title: extra.title,
          project: PROJECT_NAME,
          projectPath: extra.projectPath ?? copy,
          isSandbox: false,
          messageCount: 1,
          createdAt: new Date(Date.now() - 10 * 60_000).toISOString(),
          updatedAt: new Date().toISOString(),
          preview: '',
          ...extra,
        });
        // Список чатов — подмена (родитель — запись разделения, а не транскрипт);
        // дерево с сигналами отдаёт настоящая панель.
        const chats = [
          chat(PARENT, { title: 'Пачка задач QA' }),
          chat(SESSION, {
            title: 'Работа группы «Сложение»',
            parentId: PARENT,
            stage: 'work',
            groupTitle: 'Сложение',
            groupIndex: 0,
            branch: 'feature/sum',
          }),
        ];
        await page.route('**/api/chats', (route) => route.fulfill({ json: chats }));
        await page.route('**/api/chats/projects*', (route) =>
          route.fulfill({
            json: [
              {
                path: copy,
                name: PROJECT_NAME,
                exists: true,
                lastActivity: new Date().toISOString(),
                chats: [],
              },
            ],
          }),
        );
        await page.route('**/api/chats/*/messages*', (route) =>
          route.fulfill({
            json: {
              messages: [
                {
                  id: 'm-1',
                  role: 'assistant',
                  blocks: [{ type: 'text', text: 'Разделил задачи на группы.' }],
                  timestamp: new Date(Date.now() - 9 * 60_000).toISOString(),
                },
              ],
              total: 1,
              hasMore: false,
            },
          }),
        );
        await page.goto(`${stand.webUrl}/chat`, { waitUntil: 'domcontentloaded' });
        await page.waitForSelector('nav', { timeout: 30_000 });
        await page.getByRole('tab', { name: 'Проекты' }).click();
        await page
          .getByRole('button', { name: new RegExp(PROJECT_NAME) })
          .first()
          .click();
        await page
          .getByRole('button', { name: /Пачка задач QA/ })
          .first()
          .click();
        const hub = page.locator('[data-child-hub]');
        await hub.waitFor({ timeout: 20_000 }).catch(() => {});
        return { page, hub };
      };
      const browser = await chromium.launch();
      try {
        const { page, hub } = await openHub(browser);
        const island = hub.locator('[data-group-watch]');
        await island.waitFor({ timeout: 15_000 }).catch(() => {});
        const islandText = (await island.count()) ? await island.innerText() : '';
        check(
          'в карточке группы — остров сигналов с проверкой по кругу и её командой',
          islandText.includes('Одна и та же проверка по кругу') && islandText.includes(CHECK),
          islandText.replace(/\s+/g, ' ').slice(0, 600),
        );
        const chip = hub.locator('[data-hub-count="signals"]');
        const chipText = (await chip.count()) ? await chip.innerText() : '';
        check('в сводке хаба — фишка «сигналов: 3»', /(?<!\d)3(?!\d)/.test(chipText), chipText);
        if (process.env.QA_SHOT)
          await page.screenshot({ path: process.env.QA_SHOT, fullPage: true });
        check('страница без ошибок', page.errors.length === 0, page.errors.join('\n'));
        await page.close();
      } finally {
        await browser.close();
      }

      // ------------------------------------------------------------------ ход 2
      const sentBefore = telegram.length;
      const second = await send('QA_WATCH_2 поправь сложение');
      check('ход 2 принят', second.status === 200, second.text.slice(0, 300));
      let r4After;
      for (let t = 0; t < 30_000; t += 500) {
        await wait(500);
        list = await signals();
        r4After = list.find((one) => one.rule === 'R4');
        if (calls().length >= 2 && r4After?.clearedAt) break;
      }
      check(
        'после правки R4 закрыт сам (clearedAt), R3 и R5 держатся',
        Boolean(r4After?.clearedAt) && Boolean(active(list, 'R3')) && Boolean(active(list, 'R5')),
        JSON.stringify(list.map((one) => ({ rule: one.rule, cleared: one.clearedAt ?? null }))),
      );
      // Отправка в Telegram асинхронна (`void`): без паузы поздняя отправка при
      // закрытии пришла бы уже после подсчёта, и проверка осталась бы зелёной.
      await wait(2_000);
      check(
        'закрытие сигнала в Telegram не шлётся',
        telegram.length === sentBefore,
        String(telegram.length),
      );

      // ------------------------------------------- хаб после хода 2: клики
      const browser2 = await chromium.launch();
      try {
        const { page, hub } = await openHub(browser2);
        const island = hub.locator('[data-group-watch]').first();
        await island.waitFor({ timeout: 15_000 }).catch(() => {});
        const toggle = island.locator('[data-watch-cleared-toggle]');
        const closedBefore = (await toggle.count())
          ? await toggle.getAttribute('aria-expanded')
          : null;
        const r4Hidden = !(await island.innerText()).includes(CHECK);
        check(
          'закрытый R4 свёрнут: переключатель «закрытый сигнал: 1» закрыт, команды R4 не видно',
          closedBefore === 'false' && r4Hidden,
          `${closedBefore} / ${r4Hidden}`,
        );
        if (await toggle.count()) await toggle.click();
        const cleared = island.locator('[data-watch-cleared]');
        await cleared
          .first()
          .waitFor({ timeout: 5_000 })
          .catch(() => {});
        const clearedText = (await cleared.count()) ? await cleared.first().innerText() : '';
        check(
          'клик раскрывает закрытые: строка R4 с командой и «закрыт …», aria-expanded=true',
          (await toggle.getAttribute('aria-expanded').catch(() => null)) === 'true' &&
            clearedText.includes(CHECK) &&
            clearedText.includes('закрыт'),
          clearedText.replace(/\s+/g, ' ').slice(0, 200),
        );
        const openNames = await island
          .locator('[data-watch-open]')
          .evaluateAll((nodes) => nodes.map((node) => node.getAttribute('aria-label')));
        check(
          'у кнопок «Открыть чат» разные имена — правило и стадия',
          openNames.length === 2 && new Set(openNames).size === 2,
          JSON.stringify(openNames),
        );
        await island.getByRole('button', { name: /Открыть чат: R3/ }).click();
        await page.waitForURL(new RegExp(SESSION), { timeout: 10_000 }).catch(() => {});
        check('«Открыть чат» у R3 ведёт в чат группы', page.url().includes(SESSION), page.url());
        check('страница без ошибок (клики)', page.errors.length === 0, page.errors.join('\n'));
        await page.close();
      } finally {
        await browser2.close();
      }

      // ------------------------------------------------------- свежая группа
      const freshSent = telegram.length;
      const born = await stand.api('/chat/send', {
        method: 'POST',
        body: {
          chatId: NEW_KEY,
          prompt: 'QA_WATCH_FRESH_1 начинай работу группы',
          projectPath: copy,
        },
      });
      check('первый ход свежей группы принят', born.status === 200, born.text.slice(0, 300));
      let fresh = [];
      for (let t = 0; t < 30_000; t += 500) {
        await wait(500);
        fresh = await signals(1);
        if (active(fresh, 'R5')) break;
      }
      const r5Fresh = active(fresh, 'R5');
      check(
        'R5 первого хода живёт под рождённой сессией, двойника под new-… нет',
        r5Fresh?.chatId === FRESH && !fresh.some((one) => String(one.chatId).startsWith('new-')),
        JSON.stringify(fresh.map((one) => ({ rule: one.rule, chatId: one.chatId }))),
      );
      for (let t = 0; t < 10_000 && !active(fresh, 'R19'); t += 500) {
        await wait(500);
        fresh = await signals(1);
      }
      const r19 = active(fresh, 'R19');
      check(
        'R19: первый запрос нового разговора 110k — сведения на записи свежей группы',
        r19?.numbers?.firstK === 110 && r19.severity === 'info' && r19.chatId === FRESH,
        JSON.stringify(r19 ?? fresh.map((one) => one.rule)),
      );
      for (let t = 0; t < 10_000 && telegram.length < freshSent + 1; t += 250) await wait(250);
      await wait(2_000);
      const freshTexts = telegram.slice(freshSent).map((one) => String(one.body?.text ?? ''));
      check(
        'в Telegram ушло ровно одно сообщение — R5 свежей группы',
        freshTexts.length === 1 && freshTexts[0].includes(' R5 '),
        freshTexts.join(' | '),
      );

      // ----------------------------------------------- пустой список событий
      const unsubscribed = await stand.api('/integrations/telegram', {
        method: 'PUT',
        body: { settings: { enabled: true, chatId: '@qa-watch', events: [] }, token: '123:qa' },
      });
      check(
        'подписка Telegram снята (события — пусто)',
        unsubscribed.status === 200,
        unsubscribed.text.slice(0, 200),
      );
      const quietFrom = telegram.length;
      // Настоящий CLI записал бы транскрипт рождённой сессии сам; фальшивый — нет.
      writeFileSync(
        join(transcripts, `${FRESH}.jsonl`),
        `${transcriptLine(FRESH, 'user', 'PROJ-2 Вычитание')}\n`,
      );
      const stormed = await stand.api('/chat/send', {
        method: 'POST',
        body: {
          chatId: FRESH,
          sessionId: FRESH,
          prompt: 'QA_WATCH_FRESH_2 продолжай',
          projectPath: copy,
        },
      });
      check('второй ход свежей группы принят', stormed.status === 200, stormed.text.slice(0, 300));
      for (let t = 0; t < 30_000; t += 500) {
        await wait(500);
        fresh = await signals(1);
        if (['R3', 'R14', 'R15', 'R18'].every((rule) => active(fresh, rule))) break;
      }
      check(
        'R3 встал на запись свежей группы',
        Boolean(active(fresh, 'R3')),
        JSON.stringify(fresh),
      );
      const r15 = active(fresh, 'R15');
      check(
        'R15: `pnpm test` убит по сроку 10 мин (код 143, поток CLI) — предупреждение с вызовом',
        r15?.numbers?.timeoutMin === 10 &&
          r15.severity === 'warn' &&
          r15.params?.call === 'pnpm test',
        JSON.stringify(r15 ?? null),
      );
      const r14 = active(fresh, 'R14');
      check(
        'R14: ответ Read в 25k знаков — сведения с путём',
        r14?.numbers?.charsK === 25 && String(r14.params?.call ?? '').includes('big.log'),
        JSON.stringify(r14 ?? null),
      );
      const r18 = active(fresh, 'R18');
      check(
        'R18: пять отказов стража — с его именем из текста хука',
        r18?.numbers?.denials === 5 && r18.params?.guard === 'cmd-duration',
        JSON.stringify(r18 ?? null),
      );
      await wait(2_000);
      check(
        'без подписки на groupSignal в Telegram не ушло ничего',
        telegram.length === quietFrom,
        JSON.stringify(telegram.slice(quietFrom)).slice(0, 300),
      );
    },
  );
} finally {
  tg.close();
}
