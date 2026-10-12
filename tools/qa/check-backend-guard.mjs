/**
 * Окно «Окружение», вкладка «Защита» — живой стенд, настоящий UI и настоящий
 * `claude`, который исполняет поставленный панелью хук.
 *
 * Одноразовая панель (`throwaway-stand.mjs`), стаб модели в этом процессе
 * (`ANTHROPIC_BASE_URL` в `settings.json` стенда): модель «просит» Bash с
 * командой-меткой, и след на диске (`guard-ran.txt`) — единственное
 * доказательство, что команда исполнилась. Что проверяется:
 *
 * - API: чужой каталог — 403, настройки до установки — 409, на диске ничего;
 * - UI до установки: метка короче трёх знаков названа и не пускает поставить,
 *   «Проверить команду» отвечает по НЕсохранённому черновику (выключенное
 *   правило молчит, метка прода спрашивает); установка: итог в фокусе,
 *   «Включена», файлы поимённо; на диске — хук ПЕРВЫМ в PreToolUse, запись
 *   человека цела, настройки черновика; группа панели заведена;
 * - терминал: настоящий `claude -p` с `--allowedTools Bash` в проекте —
 *   обычная команда исполняется, узнанная защитой — нет;
 * - чат панели: чтение с меткой прода (его автоподтверждение панели пропускает
 *   само) даёт карточку прав С ПРИЧИНОЙ защиты при
 *   включённом по умолчанию автоподтверждении; «Запретить» — команда не
 *   исполнилась; обычная команда проходит без карточки (контроль);
 *   «Разрешить» — исполнилась;
 * - UI после: сохранение настроек; хук убран из settings.json руками →
 *   «Частично» → «Восстановить» → «Включена»; «Снять защиту» через
 *   подтверждение — settings.json байт в байт как до установки, группы нет;
 * - axe на вкладке в светлой и тёмной теме.
 *
 * Нужен установленный `claude` (путь — `CLAUDE_CLI`). Запуск:
 * `node tools/qa/check-backend-guard.mjs`. Выход 2 — «не проверено».
 * Снимки — в `.agent/screenshots/before-after/backend-guard/`.
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, join } from 'node:path';
import { AxeBuilder } from '@axe-core/playwright';
import { chromium } from 'playwright';
import { NotChecked, REPO, runOnStand, wait } from './throwaway-stand.mjs';
import { seedChatTranscript } from './backend-fixtures.mjs';

const SHOTS = join(REPO, '.agent', 'screenshots', 'before-after', 'backend-guard');
mkdirSync(SHOTS, { recursive: true });

const GUARD_CMD = 'terraform destroy -auto-approve; echo ran > guard-ran.txt';
// Чтение с меткой прода: автоподтверждение панели такое пропускает само — остановить может
// только защита, поэтому в чате доказательство строится на нём, а не на terraform.
const PROD_CMD = 'psql -h db.prod.internal -c "select 1"; echo ran > guard-ran.txt';
const SAFE_CMD = 'echo ran > safe-ran.txt';
const SETTINGS_BEFORE = `${JSON.stringify({ permissions: { allow: ['Bash(npm test)'] } }, null, 2)}\n`;

/** Настоящий `claude`: на Windows — `claude.exe` пакета (`.cmd` без оболочки не запускается). */
function resolveClaude() {
  if (process.env.CLAUDE_CLI) return process.env.CLAUDE_CLI;
  if (process.platform !== 'win32') return 'claude';
  const tail = join('node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe');
  for (const root of [dirname(process.execPath), join(process.env.APPDATA ?? '', 'npm')]) {
    const exe = join(root, tail);
    if (existsSync(exe)) return exe;
  }
  return '';
}

/** Каталог команды `claude` в PATH — так её найдёт панель стенда. */
function cliOnPath() {
  if (process.env.CLAUDE_CLI) return dirname(process.env.CLAUDE_CLI);
  const found = spawnSync(process.platform === 'win32' ? 'where' : 'which', ['claude'], {
    encoding: 'utf8',
  });
  const first = found.stdout?.split(/\r?\n/).find(Boolean);
  return first ? dirname(first) : dirname(resolveClaude());
}

const textsOf = (message) =>
  typeof message?.content === 'string'
    ? [message.content]
    : (message?.content ?? []).filter((part) => part.type === 'text').map((part) => part.text);

/**
 * Стаб модели. Ход с Bash в инструментах и меткой `RUN:guard` / `RUN:prod` / `RUN:safe` в
 * последнем сообщении человека — вызов Bash; есть результат инструмента — ход
 * закончен словом. Всё прочее (заголовок чата и т. п.) — «ок».
 */
function startStub() {
  const results = [];
  const requests = [];
  const server = createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      let body = {};
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
      } catch {
        // не JSON — отвечаем как на постороннее
      }
      requests.push(req.url);
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
      const messages = body.messages ?? [];
      const toolResults = messages.flatMap((message) =>
        Array.isArray(message.content)
          ? message.content.filter((part) => part.type === 'tool_result')
          : [],
      );
      const hasBash = (body.tools ?? []).some((tool) => tool.name === 'Bash');
      // Просьба и контекст CLI приходят разными сообщениями — метку ищем во всех сообщениях человека.
      const asked = messages
        .filter((message) => message.role === 'user')
        .flatMap(textsOf)
        .join('\n');
      let command;
      if (toolResults.length > 0) {
        for (const result of toolResults) {
          const content = Array.isArray(result.content)
            ? result.content.map((part) => part.text ?? '').join('\n')
            : String(result.content ?? '');
          results.push({ id: result.tool_use_id, isError: result.is_error === true, content });
        }
      } else if (hasBash && asked.includes('RUN:guard')) command = GUARD_CMD;
      else if (hasBash && asked.includes('RUN:prod')) command = PROD_CMD;
      else if (hasBash && asked.includes('RUN:safe')) command = SAFE_CMD;

      const block = command
        ? {
            start: {
              type: 'tool_use',
              id: `toolu_qa_${Math.random().toString(36).slice(2, 10)}`,
              name: 'Bash',
              input: {},
            },
            delta: {
              type: 'input_json_delta',
              partial_json: JSON.stringify({ command, description: 'qa' }),
            },
          }
        : {
            start: { type: 'text', text: '' },
            delta: { type: 'text_delta', text: toolResults.length ? 'готово' : 'ок' },
          };
      const events = [
        [
          'message_start',
          {
            type: 'message_start',
            message: {
              id: `msg_qa_${results.length}`,
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
          { type: 'content_block_start', index: 0, content_block: block.start },
        ],
        ['content_block_delta', { type: 'content_block_delta', index: 0, delta: block.delta }],
        ['content_block_stop', { type: 'content_block_stop', index: 0 }],
        [
          'message_delta',
          {
            type: 'message_delta',
            delta: { stop_reason: command ? 'tool_use' : 'end_turn' },
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
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () =>
      resolve({
        url: `http://127.0.0.1:${server.address().port}`,
        results,
        requests,
        close: () => server.close(),
      }),
    );
  });
}

const STUB_ENV = (url) => ({
  ANTHROPIC_BASE_URL: url,
  ANTHROPIC_API_KEY: 'guard-stub',
  ANTHROPIC_AUTH_TOKEN: 'guard-stub',
  ANTHROPIC_MODEL: 'stub-guard',
  DISABLE_AUTOUPDATER: '1',
  DISABLE_TELEMETRY: '1',
  DISABLE_ERROR_REPORTING: '1',
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
});

const visible = (locator, timeout = 15_000) =>
  locator
    .first()
    .waitFor({ timeout })
    .then(() => true)
    .catch(() => false);

async function waitFor(fn, timeoutMs, stepMs = 400) {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const value = await fn();
    if (value || Date.now() > until) return value;
    await wait(stepMs);
  }
}

async function closeKeyGate(page) {
  const close = page.getByRole('button', { name: 'Закрыть', exact: true });
  try {
    await close.first().waitFor({ timeout: 6000 });
    await close.first().click();
  } catch {
    // Окна не было.
  }
}

/** Чат → проект → «Окружение» → вкладка «Защита». */
async function openGuard(stand, browser, projectName, context) {
  // Своя вкладка в своём контексте: axe не разбирает страницы из browser.newPage().
  const own = context ?? (await browser.newContext({ viewport: { width: 1440, height: 1000 } }));
  const page = await own.newPage();
  page.errors = [];
  page.on('pageerror', (error) => page.errors.push(error.message));
  await page.goto(`${stand.webUrl}/chat`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('nav');
  await closeKeyGate(page);
  await page.getByRole('tab', { name: 'Проекты' }).first().click({ timeout: 15_000 });
  await page
    .getByRole('button', { name: new RegExp(projectName) })
    .first()
    .click({ timeout: 15_000 });
  await page
    .getByRole('button', { name: /^Окружение$/ })
    .first()
    .click({ timeout: 15_000 });
  const dialog = page.getByRole('dialog', { name: 'Окружение проекта' });
  await dialog.waitFor({ timeout: 15_000 });
  await dialog.getByRole('tab', { name: 'Защита' }).click();
  await dialog.getByRole('heading', { name: 'Защита бэкенда' }).waitFor({ timeout: 15_000 });
  return { page, dialog };
}

async function axe(page) {
  await wait(600);
  const results = await new AxeBuilder({ page })
    .include('[role="dialog"]')
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();
  return results.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
}

const exe = resolveClaude();
if (!exe) {
  console.log('Не проверено: не нашёлся настоящий `claude` — задайте путь через CLAUDE_CLI.');
  process.exit(2);
}
const stub = await startStub();
let project;
let stranger;

await runOnStand(
  {
    label: 'guard',
    settings: { theme: 'system' },
    // Панель зовёт `claude` (на Windows — `claude.cmd`) по PATH: нужен каталог
    // команды из `where`, а не каталог `claude.exe` внутри пакета.
    extraPath: [cliOnPath()],
    seed: ({ root, cfg }) => {
      project = join(root, 'demo', 'shop-api');
      stranger = join(root, 'outside', 'stranger');
      mkdirSync(join(project, '.claude'), { recursive: true });
      mkdirSync(stranger, { recursive: true });
      writeFileSync(join(project, '.claude', 'settings.json'), SETTINGS_BEFORE, 'utf8');
      writeFileSync(join(project, 'package.json'), '{"name":"shop-api"}\n', 'utf8');
      // CLI стенда ходит в стаб: адрес — в его settings.json, как бы панель его ни запускала.
      writeFileSync(
        join(cfg, 'settings.json'),
        `${JSON.stringify({ env: STUB_ENV(stub.url) }, null, 2)}\n`,
        'utf8',
      );
      seedChatTranscript(cfg, project);
    },
  },
  async (stand, check) => {
    const added = await stand.api('/projects', {
      method: 'POST',
      body: { path: project, name: 'shop-api' },
    });
    if (added.status >= 300) throw new NotChecked(`проект не добавился: ${added.text}`);
    const settingsPath = join(project, '.claude', 'settings.json');
    const guardJson = () =>
      JSON.parse(readFileSync(join(project, '.claude', 'backend-guard.json'), 'utf8'));

    /* ── API: границы ─────────────────────────────────────────────── */
    const foreign = await stand.api('/backend-guard/install', {
      method: 'POST',
      body: { path: stranger, settings: { prodMarkers: [], disabled: [] } },
    });
    check(
      'чужой каталог: 403, на диске ничего',
      foreign.status === 403 &&
        foreign.body?.code === 'guard-project-unregistered' &&
        !existsSync(join(stranger, '.claude')),
      `${foreign.status} ${foreign.text}`,
    );
    const early = await stand.api('/backend-guard/settings', {
      method: 'PUT',
      body: { path: project, settings: { prodMarkers: [], disabled: [] } },
    });
    check(
      'настройки до установки: 409, файла настроек нет',
      early.status === 409 && !existsSync(join(project, '.claude', 'backend-guard.json')),
      `${early.status}`,
    );

    const browser = await chromium.launch();
    try {
      /* ── UI: черновик, проверка, установка ───────────────────────── */
      const { page, dialog } = await openGuard(stand, browser, 'shop-api');
      check('до установки: «Не стоит»', await visible(dialog.getByText('Не стоит')));
      const violationsNone = await axe(page);
      check(
        'axe (светлая, до установки): без серьёзных',
        violationsNone.length === 0,
        violationsNone.map((v) => v.id).join(', '),
      );

      const markers = dialog.getByRole('textbox', { name: 'Метки прода' });
      await markers.fill('pr');
      const install = dialog.getByRole('button', { name: 'Поставить защиту' });
      check(
        'метка «pr»: названа и не пускает поставить',
        (await visible(dialog.getByText(/Короче трёх знаков: pr/))) && (await install.isDisabled()),
      );
      await markers.fill('db.prod.internal');
      await dialog.getByRole('switch', { name: 'Спрашивать: Удаление томов Docker' }).click();

      const command = dialog.getByRole('textbox', { name: 'Команда' });
      const checkBtn = dialog.getByRole('button', { name: 'Проверить', exact: true });
      await command.fill('docker volume rm shop_data');
      await checkBtn.click();
      check(
        'проверка: выключенное правило молчит (черновик, не сохранён)',
        await visible(dialog.getByText('Пройдёт без вопроса защиты.')),
      );
      await command.fill('psql -h db.prod.internal -c "select 1"');
      check(
        'правка команды гасит старый вердикт',
        !(await dialog.getByText('Пройдёт без вопроса защиты.').isVisible()),
      );
      await command.press('Enter');
      check(
        'проверка: метка прода из черновика спрашивает (Enter в поле)',
        await visible(dialog.getByText('Спросит — Обращение к проду: db.prod.internal')),
      );
      await page.screenshot({ path: join(SHOTS, 'guard-draft-check_AFTER.png') });

      await install.click();
      const notice = dialog.getByRole('status').filter({ hasText: 'Защита стоит' });
      check('установка: итог виден', await visible(notice));
      check(
        'установка: фокус на итоге, а не потерян',
        await notice.evaluate((node) => node === document.activeElement).catch(() => false),
      );
      check(
        '«Включена» и файлы поимённо',
        (await visible(dialog.getByText('Включена'))) &&
          (await visible(dialog.getByText('.claude/hooks/backend-guard.mjs'))),
      );
      await page.screenshot({ path: join(SHOTS, 'guard-installed_AFTER.png') });

      const settings = JSON.parse(readFileSync(settingsPath, 'utf8'));
      const pre = settings.hooks?.PreToolUse ?? [];
      check(
        'settings.json: хук первым, запись человека цела',
        pre[0]?.matcher === 'Bash|mcp__.*' &&
          /backend-guard\.mjs/.test(pre[0]?.hooks?.[0]?.command ?? '') &&
          JSON.stringify(settings.permissions) === JSON.stringify({ allow: ['Bash(npm test)'] }),
        JSON.stringify(settings),
      );
      const stored = guardJson();
      check(
        'backend-guard.json: настройки черновика и язык',
        JSON.stringify(stored.prodMarkers) === '["db.prod.internal"]' &&
          JSON.stringify(stored.disabled) === '["volume-delete"]' &&
          stored.lang === 'ru',
        JSON.stringify(stored),
      );
      const groups = (await stand.api('/groups')).body;
      const groupList = Array.isArray(groups) ? groups : (groups?.groups ?? []);
      check(
        'группа «Защита бэкенда · shop-api» заведена',
        groupList.some((group) => group.name === 'Защита бэкенда · shop-api'),
        JSON.stringify(groupList.map((group) => group.name)),
      );
      await page.close();

      /* ── Терминал: настоящий claude исполняет хук ───────────────── */
      // Асинхронно: стаб модели живёт в этом же процессе, и spawnSync держал бы его глухим.
      const terminal = (prompt) =>
        new Promise((resolve) => {
          const child = spawn(
            exe,
            ['-p', prompt, '--allowedTools', 'Bash', '--output-format', 'json'],
            {
              cwd: project,
              windowsHide: true,
              // Без закрытого stdin CLI ждёт ввода три секунды и пишет предупреждение.
              stdio: ['ignore', 'pipe', 'pipe'],
              env: { ...process.env, CLAUDE_CONFIG_DIR: stand.cfg, ...STUB_ENV(stub.url) },
            },
          );
          let stdout = '';
          let stderr = '';
          child.stdout.on('data', (chunk) => (stdout += chunk));
          child.stderr.on('data', (chunk) => (stderr += chunk));
          const timer = setTimeout(() => child.kill(), 120_000);
          child.on('exit', (status) => {
            clearTimeout(timer);
            resolve({ status, stdout, stderr });
          });
        });
      const ran = (file) => existsSync(join(project, file));
      const from = stub.results.length;
      const safe = await terminal('RUN:safe');
      check(
        'терминал: обычная команда исполнилась (контроль)',
        ran('safe-ran.txt'),
        `exit ${safe.status} ${safe.error ?? ''}; запросы к стабу: ${stub.requests.join(' ')}
    stdout: ${safe.stdout?.slice(-400)}
    stderr: ${safe.stderr?.slice(-600)}`,
      );
      const guarded = await terminal('RUN:guard');
      const verdict = stub.results.slice(from).at(-1);
      check(
        'терминал: узнанная команда НЕ исполнилась',
        !ran('guard-ran.txt'),
        `exit ${guarded.status}; результат: ${JSON.stringify(verdict)}`,
      );
      check(
        'терминал: модель получила отказ с причиной защиты, а не вывод команды',
        verdict?.isError === true &&
          (verdict?.content ?? '').includes('Защита бэкенда: изменение инфраструктуры'),
        JSON.stringify(verdict),
      );
      rmSync(join(project, 'safe-ran.txt'), { force: true });

      /* ── Чат панели: карточка с причиной мимо автоподтверждения ──── */
      // Ответ отправки — поток хода до конца; держим его, чтобы назвать причину провала.
      const sent = {};
      const send = (chatId, prompt) => {
        sent[chatId] = stand.api('/chat/send', {
          method: 'POST',
          body: { chatId, prompt, projectPath: project },
        });
      };
      const sentText = async (chatId) => {
        const response = await Promise.race([sent[chatId], wait(2000).then(() => undefined)]);
        return response ? `${response.status} ${response.text.slice(-700)}` : 'поток ещё идёт';
      };
      const runOf = (chatId) =>
        waitFor(async () => {
          const active = (await stand.api('/chat/active')).body;
          return Array.isArray(active)
            ? active.find((run) => run.chatId === chatId && run.sessionId)
            : undefined;
        }, 30_000);
      const finished = (chatId) =>
        waitFor(async () => {
          const active = (await stand.api('/chat/active')).body;
          return (
            Array.isArray(active) &&
            !active.some((run) => run.chatId === chatId && run.status === 'running')
          );
        }, 60_000);

      const chatPage = await stand.newPage(browser, { width: 1440, height: 1000 });
      const answerCard = async (chatId, button) => {
        const run = await runOf(chatId);
        if (!run?.sessionId) return { card: false, reason: false };
        await chatPage.goto(`${stand.webUrl}/chat?id=${run.sessionId}`, {
          waitUntil: 'domcontentloaded',
        });
        await closeKeyGate(chatPage);
        const reason = chatPage.getByText('Защита бэкенда: команда обращается к проду');
        const card = await visible(
          chatPage.getByRole('button', { name: button, exact: true }),
          45_000,
        );
        const hasReason = card && (await visible(reason, 5000));
        const hasMatch =
          card && (await visible(chatPage.getByText('Узнала: db.prod.internal'), 5000));
        if (card) {
          await chatPage.screenshot({ path: join(SHOTS, `guard-chat-card-${button}_AFTER.png`) });
          await chatPage.getByRole('button', { name: button, exact: true }).first().click();
        }
        await finished(chatId);
        return { card, reason: hasReason && hasMatch };
      };

      const fromDeny = stub.results.length;
      send('new-guard-deny', 'RUN:prod');
      const deny = await answerCard('new-guard-deny', 'Запретить');
      check(
        'чат: карточка прав с причиной защиты и узнанным текстом',
        deny.card && deny.reason,
        `карточка ${deny.card}, причина ${deny.reason}; запросы к стабу: ${stub.requests.length}; ответ: ${await sentText('new-guard-deny')}`,
      );
      check('чат: «Запретить» — команда не исполнилась', !ran('guard-ran.txt'));
      check(
        'чат: модель получила отказ',
        stub.results.slice(fromDeny).some((result) => result.isError),
        JSON.stringify(stub.results.slice(fromDeny)),
      );

      send('new-guard-safe', 'RUN:safe');
      await runOf('new-guard-safe');
      await finished('new-guard-safe');
      check(
        'чат, контроль: обычная команда прошла без карточки (автоподтверждение работает)',
        ran('safe-ran.txt'),
      );

      send('new-guard-allow', 'RUN:prod');
      const allow = await answerCard('new-guard-allow', 'Разрешить');
      check(
        'чат: карточка снова, «Разрешить» — команда исполнилась',
        allow.card && ran('guard-ran.txt'),
      );
      await chatPage.close();

      /* ── UI: настройки, «частично», восстановление, снятие ───────── */
      const again = await openGuard(stand, browser, 'shop-api');
      await again.dialog
        .getByRole('textbox', { name: 'Метки прода' })
        .fill('db.prod.internal\n10.0.5.12');
      check(
        'правка: «Есть несохранённые правки»',
        await visible(again.dialog.getByText('Есть несохранённые правки.')),
      );
      await again.dialog.getByRole('button', { name: 'Сохранить настройки' }).click();
      check('сохранение: итог', await visible(again.dialog.getByText('Настройки сохранены.')));
      check(
        'сохранение: на диске новые метки, скрипт не тронут',
        JSON.stringify(guardJson().prodMarkers) === '["db.prod.internal","10.0.5.12"]',
        JSON.stringify(guardJson()),
      );
      const darkContext = await browser.newContext({
        viewport: { width: 1440, height: 1000 },
        colorScheme: 'dark',
      });
      const dark = await openGuard(stand, browser, 'shop-api', darkContext);
      const violationsDark = await axe(dark.page);
      check(
        'axe (тёмная, защита стоит): без серьёзных',
        violationsDark.length === 0,
        violationsDark.map((v) => v.id).join(', '),
      );
      await dark.page.screenshot({ path: join(SHOTS, 'guard-installed-dark_AFTER.png') });
      await darkContext.close();
      await again.page.close();

      // Хук убран руками — защита молчит, и окно обязано это сказать.
      writeFileSync(settingsPath, SETTINGS_BEFORE, 'utf8');
      const partial = await openGuard(stand, browser, 'shop-api');
      check(
        '«Частично» и запись в settings.json — «нет»',
        (await visible(partial.dialog.getByText('Частично'))) &&
          (await visible(partial.dialog.getByText('нет', { exact: true }))),
      );
      await partial.page.screenshot({ path: join(SHOTS, 'guard-partial_AFTER.png') });
      await partial.dialog.getByRole('button', { name: 'Восстановить' }).click();
      check('«Восстановить» → «Включена»', await visible(partial.dialog.getByText('Включена')));

      await partial.dialog.getByRole('button', { name: 'Снять защиту' }).click();
      const confirm = partial.page
        .getByRole('alertdialog')
        .or(partial.page.getByRole('dialog', { name: 'Снять защиту бэкенда?' }));
      check('снятие спрашивает подтверждение', await visible(confirm));
      await partial.page.getByRole('button', { name: 'Снять', exact: true }).click();
      check('после снятия: «Не стоит»', await visible(partial.dialog.getByText('Не стоит')));
      check(
        'settings.json байт в байт как до установки',
        readFileSync(settingsPath, 'utf8') === SETTINGS_BEFORE,
        readFileSync(settingsPath, 'utf8'),
      );
      check(
        'файлы защиты ушли',
        !existsSync(join(project, '.claude', 'hooks', 'backend-guard.mjs')) &&
          !existsSync(join(project, '.claude', 'rules', 'backend-safety.md')) &&
          !existsSync(join(project, '.claude', 'backend-guard.json')),
      );
      const after = (await stand.api('/groups')).body;
      const afterList = Array.isArray(after) ? after : (after?.groups ?? []);
      check(
        'группы защиты нет',
        !afterList.some((group) => String(group.name).startsWith('Защита бэкенда')),
      );
      check(
        'ошибок страницы нет',
        partial.page.errors.length === 0,
        partial.page.errors.join('\n'),
      );
      await partial.page.close();
    } finally {
      await browser.close();
      stub.close();
    }
  },
);
