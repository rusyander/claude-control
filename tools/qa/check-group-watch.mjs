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
 * сторож читает пороги на ходу. Ожидается:
 *   - на записи группы активны R3 (шторм сжатий), R4 (проверка по кругу),
 *     R5 (ревью в работе) с числами;
 *   - в Telegram ушли три сообщения «внимание» с номером правила и проектом;
 *   - в хабе родителя у карточки группы остров сигналов и фишка в сводке.
 * Ход 2: правка файла → R4 закрыт (clearedAt), R3 и R5 держатся.
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
const session = after('--resume') ?? after('--session-id') ?? ${JSON.stringify(SESSION)};
const out = (event) => process.stdout.write(JSON.stringify({ ...event, session_id: session }) + '\n');
let n = 0;
const tool = (name, input, result) => {
  n += 1;
  const id = 'toolu_qa_' + n;
  out({ type: 'assistant', message: { id: 'msg_qa_' + n, role: 'assistant', model: 'claude-opus-5', content: [{ type: 'tool_use', id, name, input }] } });
  out({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: result }] } });
};
const compact = () => out({ type: 'system', subtype: 'compact_boundary', compact_metadata: { trigger: 'auto', pre_tokens: 180000 } });

function turn(text) {
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
        const dir = join(cfg, 'projects', copy.replace(/[^a-zA-Z0-9]/g, '-'));
        mkdirSync(dir, { recursive: true });
        const line = (type, content) =>
          JSON.stringify({ type, sessionId: SESSION, cwd: copy, message: { role: type, content } });
        writeFileSync(
          join(dir, `${SESSION}.jsonl`),
          `${line('user', 'PROJ-1 Сложение')}\n${line('assistant', [{ type: 'text', text: 'Начинаю.' }])}\n`,
        );

        const createdAt = new Date(Date.now() - 5 * 60_000).toISOString();
        const plan = {
          parentChatId: PARENT,
          projectPath: copy,
          createdAt,
          order: [0],
          request: {},
          proposal: {
            groups: [{ title: 'Сложение', branch: 'feature/sum', tasks: ['PROJ-1 Сложение'] }],
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
        const file = join(cfg, 'agentdeck', 'state.json');
        const state = JSON.parse(readFileSync(file, 'utf8'));
        writeFileSync(
          file,
          `${JSON.stringify({ ...state, splitPlans: { [PARENT]: plan }, chatLinks: { [SESSION]: link } })}\n`,
        );
      },
    },
    async (stand, check) => {
      const calls = () => {
        const file = join(stand.bin, 'calls.jsonl');
        return existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean) : [];
      };
      const group = async () => (await stand.api(`/chat/${PARENT}/tree`)).body?.split?.groups?.[0];
      const signals = async () => (await group())?.watchSignals ?? [];
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
        body: { settings: { enabled: true, chatId: '@qa-watch', events: [] }, token: '123:qa' },
      });
      check(
        'Telegram включён (события — пусто)',
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
      const texts = telegram.map((one) => String(one.body?.text ?? ''));
      check(
        'в Telegram ушли R3, R4 и R5 — адресату и через бота заглушки',
        ['R3', 'R4', 'R5'].every((rule) => texts.some((text) => text.includes(` ${rule} `))) &&
          telegram.every(
            (one) =>
              one.body?.chat_id === '@qa-watch' && one.path.startsWith('/bot123:qa/sendMessage'),
          ),
        JSON.stringify(telegram).slice(0, 600),
      );
      check(
        'текст сигнала называет проект',
        texts.every((text) => text.includes(basename(copy))),
        texts.join(' | '),
      );
      const r4Text = texts.find((text) => text.includes(' R4 ')) ?? '';
      console.log(`     Telegram R4: ${r4Text}`);

      // ------------------------------------------------------------------ хаб
      const browser = await chromium.launch();
      try {
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
        const island = hub.locator('[data-group-watch]');
        await island.waitFor({ timeout: 15_000 }).catch(() => {});
        const islandText = (await island.count()) ? await island.innerText() : '';
        check(
          'в карточке группы — остров сигналов с проверкой по кругу и её командой',
          islandText.includes('Одна проверка по кругу') && islandText.includes(CHECK),
          islandText.replace(/\s+/g, ' ').slice(0, 300),
        );
        const chip = hub.locator('[data-hub-count="signals"]');
        const chipText = (await chip.count()) ? await chip.innerText() : '';
        check('в сводке хаба — фишка «сигналов: 3»', /3/.test(chipText), chipText);
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
    },
  );
} finally {
  tg.close();
}
