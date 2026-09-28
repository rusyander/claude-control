/**
 * Кейс settings-models-007: у строк «Аналитика → Сессии» есть «Перейти» и
 * «Остановить», и оба говорят правду о том, где идёт сессия.
 *
 * Одноразовый стенд (`throwaway-stand.mjs`) с четырьмя транскриптами во
 * временном доме:
 *  - `qa-running` — идёт, её ведёт настоящий процесс, запущенный ЭТОЙ проверкой
 *    (`claude.js --resume <id>` с одним потомком): стоп снимает его деревом;
 *  - `qa-unknown` — транскрипт свежий, процесса нет: «не опознан», стопа нет;
 *  - `qa-finished` — давно не пишется: «Перейти» ведёт в её разговор;
 *  - `qa-gone` — процесс есть при открытии окна, но проверка сама снимает его
 *    до подтверждения: итог «процесса уже нет», а не «остановлено»;
 *  - `qa-panel` — чат, запущенный САМОЙ панелью стенда: её `claude` на PATH —
 *    фальшивый (`PANEL_CLI`), он пишет транскрипт и не кончает ход, пока его не
 *    снимут. «Перейти» ведёт в этот чат, «Остановить» — стоп чата панели, а не
 *    снятие процесса.
 * Снимаются только процессы, запущенные этой проверкой; настоящий `~/.claude`
 * и стенд человека не затрагиваются.
 *
 * `SHOTS=<каталог>` — снимки вкладки и окон (для до/после).
 * Запуск: `node tools/qa/check-analytics-sessions.mjs` (стенд поднимается сам).
 */
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { runOnStand, wait } from './throwaway-stand.mjs';

const SHOTS = process.env.SHOTS;
if (SHOTS) mkdirSync(SHOTS, { recursive: true });

const IDS = {
  running: '11111111-1111-4111-8111-111111111111',
  unknown: '22222222-2222-4222-8222-222222222222',
  finished: '33333333-3333-4333-8333-333333333333',
  gone: '44444444-4444-4444-8444-444444444444',
};

/**
 * `claude` панели стенда: транскрипт сессии в каталоге конфигурации, строка
 * `init` и ход, который не кончается. Выходит сам, когда стенд снимает метку
 * жизни (`STAND_ALIVE`), — каталог стенда не остаётся занятым.
 */
const PANEL_CLI = String.raw`
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

const argv = process.argv.slice(2);
if (argv[0] === '--version' || argv[0] === '-v') {
  process.stdout.write('2.1.0 (Claude Code)\n');
  process.exit(0);
}
const ALIVE = fileURLToPath(import.meta.url).replace(/[^\\/]+$/, '.stand-alive');
setInterval(() => {
  if (!existsSync(ALIVE)) process.exit(0);
}, 250);

const after = (flag) => {
  const at = argv.indexOf(flag);
  return at >= 0 ? argv[at + 1] : undefined;
};
// Новый разговор панель начинает без номера сессии: его, как и настоящий CLI,
// называет строка init.
const id = after('--session-id') ?? after('--resume') ?? after('-r') ?? randomUUID();
{
  const cfg = process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude');
  const dir = join(cfg, 'projects', process.cwd().replace(/[^a-zA-Z0-9]/g, '-'));
  mkdirSync(dir, { recursive: true });
  const base = { sessionId: id, cwd: process.cwd(), timestamp: new Date().toISOString(), gitBranch: 'main' };
  const lines = [
    { ...base, type: 'user', message: { role: 'user', content: 'задача qa-panel' } },
    {
      ...base,
      type: 'assistant',
      requestId: 'req-panel',
      message: {
        id: 'msg-panel',
        role: 'assistant',
        model: 'claude-sonnet-4-5',
        content: [{ type: 'text', text: 'думаю' }],
        usage: { input_tokens: 10, output_tokens: 5 },
      },
    },
  ];
  writeFileSync(join(dir, id + '.jsonl'), lines.map((line) => JSON.stringify(line)).join('\n') + '\n');
  process.stdout.write(
    JSON.stringify({ type: 'system', subtype: 'init', session_id: id, cwd: process.cwd(), tools: [] }) + '\n',
  );
}
`;

/** Процессы этой проверки — только их она и снимает при выходе. */
const mine = [];
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
process.on('exit', () => {
  for (const pid of mine) if (alive(pid)) process.kill(pid);
});

/** Транскрипт с одним ответом модели; `ageMin` — сколько минут назад он писался. */
function seedTranscript(cfg, root, name, id, ageMin) {
  const project = join(root, name);
  mkdirSync(project, { recursive: true });
  const dir = join(cfg, 'projects', project.replace(/[^a-zA-Z0-9]/g, '-'));
  mkdirSync(dir, { recursive: true });
  const stamp = new Date(Date.now() - ageMin * 60_000).toISOString();
  const base = { sessionId: id, cwd: project, timestamp: stamp, gitBranch: 'main' };
  const lines = [
    { ...base, type: 'user', message: { role: 'user', content: `задача ${name}` } },
    {
      ...base,
      type: 'assistant',
      requestId: `req-${name}`,
      message: {
        id: `msg-${name}`,
        role: 'assistant',
        model: 'claude-sonnet-4-5',
        content: [{ type: 'text', text: 'готово' }],
        usage: { input_tokens: 1200, output_tokens: 300 },
      },
    },
  ];
  const file = join(dir, `${id}.jsonl`);
  writeFileSync(file, `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`);
  const at = (Date.now() - ageMin * 60_000) / 1000;
  utimesSync(file, at, at);
  return project;
}

/** Поддельный CLI: имя `claude.js` — чтобы панель признала агента; внутри сон и потомок. */
function spawnFakeCli(root, id) {
  const script = join(root, 'claude.js');
  writeFileSync(
    script,
    [
      "const { spawn } = require('node:child_process');",
      "const kid = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });",
      "require('node:fs').writeFileSync(process.argv[4], String(kid.pid));",
      'setInterval(() => {}, 1000);',
    ].join('\n'),
  );
  const kidFile = join(root, `${id}.kid`);
  const child = spawn(process.execPath, [script, '--resume', id, kidFile], { stdio: 'ignore' });
  mine.push(child.pid);
  const exited = new Promise((done) => child.once('exit', done));
  return { child, exited, kid: () => Number(readFileSync(kidFile, 'utf8')) };
}

await runOnStand(
  { label: 'analytics-sessions', fakeCli: { claude: PANEL_CLI } },
  async (stand, check) => {
    // Завершённая = тише окна «идёт» (10 мин) и всё ещё «сегодня» — вкладка по
    // умолчанию показывает день. Прогон в 00:35 клал её во вчера, и «Перейти»
    // искалось в строке, которой нет (29.09). Первые минуты суток — переждать.
    const sinceMidnight = () => {
      const now = new Date();
      return now.getHours() * 60 + now.getMinutes();
    };
    while (sinceMidnight() < 13) await wait(30_000);
    const finishedAge = Math.min(40, sinceMidnight() - 1);
    const projects = {};
    for (const [key, age] of [
      ['running', 1],
      ['unknown', 1],
      ['finished', finishedAge],
      ['gone', 1],
    ]) {
      projects[key] = seedTranscript(stand.cfg, stand.root, `qa-${key}`, IDS[key], age);
    }
    const registered = await stand.api('/projects', {
      method: 'POST',
      body: { path: projects.running },
    });
    check('проект qa-running в реестре', registered.status === 200, registered.text.slice(0, 200));

    const running = spawnFakeCli(stand.root, IDS.running);
    const gone = spawnFakeCli(stand.root, IDS.gone);
    await wait(1500);
    mine.push(running.kid(), gone.kid());

    const browser = await chromium.launch();
    try {
      const page = await stand.newPage(browser, { width: 1440, height: 1000 });
      await page.goto(`${stand.webUrl}/analytics?tab=sessions`, { waitUntil: 'domcontentloaded' });
      await page.getByText('Последние сессии').first().waitFor({ timeout: 60_000 });
      const button = (label, key) =>
        page.getByRole('button', { name: new RegExp(`^${label}: .*qa-${key}$`) });
      await button('Перейти', 'running').waitFor({ timeout: 30_000 });
      if (SHOTS) await page.screenshot({ path: join(SHOTS, '01-tab.png') });

      check(
        'идущая сессия: есть «Остановить»',
        (await button('Остановить', 'running').count()) === 1,
      );
      check(
        'неопознанная идущая: есть «Остановить»',
        (await button('Остановить', 'unknown').count()) === 1,
      );
      check(
        'завершённая: «Остановить» нет',
        (await button('Остановить', 'finished').count()) === 0,
      );
      check('завершённая: «Перейти» есть', (await button('Перейти', 'finished').count()) === 1);

      const dialog = page.getByRole('dialog');
      const closeDialog = async () => {
        await page.keyboard.press('Escape');
        await dialog.waitFor({ state: 'hidden', timeout: 5000 }).catch(() => undefined);
      };

      // ── «Перейти» у процесса вне панели: окно «где идёт» и проект ──────────
      await button('Перейти', 'running').click();
      await dialog.getByText('Где идёт сессия').waitFor({ timeout: 30_000 });
      const whereText = await dialog.innerText();
      check(
        'где идёт: терминал, номер процесса, команда и каталог',
        whereText.includes('В терминале — вне панели') &&
          whereText.includes(`PID ${running.child.pid}`) &&
          whereText.includes(`claude.js --resume ${IDS.running}`) &&
          whereText.includes(projects.running),
        whereText.replace(/\s+/g, ' '),
      );
      if (SHOTS) await dialog.screenshot({ path: join(SHOTS, '02-where.png') });
      await dialog.getByRole('button', { name: 'Открыть проект' }).click();
      await page.waitForURL(/\/projects\?id=/, { timeout: 10_000 }).catch(() => undefined);
      check(
        'где идёт: «Открыть проект» ведёт на страницу проекта',
        /\/projects\?id=/.test(page.url()),
        page.url(),
      );

      await page.goto(`${stand.webUrl}/analytics?tab=sessions`, { waitUntil: 'domcontentloaded' });
      await button('Перейти', 'unknown').waitFor({ timeout: 30_000 });

      // ── Неопознанная: объяснение, проекта нет, стопа нет ─────────────────────
      await button('Перейти', 'unknown').click();
      await dialog.getByText('Где идёт сессия').waitFor({ timeout: 30_000 });
      const unknownWhere = await dialog.innerText();
      check(
        'неопознанная: сказано, почему процесс не найден',
        unknownWhere.includes('процесс не опознан'),
        unknownWhere.replace(/\s+/g, ' '),
      );
      check(
        'неопознанная: проект не в панели — кнопка недоступна и сказано почему',
        (await dialog.getByRole('button', { name: 'Открыть проект' }).isDisabled()) &&
          unknownWhere.includes('Проект не добавлен в панель'),
      );
      await closeDialog();
      await button('Остановить', 'unknown').click();
      await dialog.getByText('Остановить сессию?').waitFor({ timeout: 30_000 });
      check(
        'неопознанная: окно стопа объясняет и не предлагает снять',
        (await dialog.getByText('процесс не опознан').count()) === 1 &&
          (await dialog.getByRole('button', { name: 'Остановить', exact: true }).count()) === 0,
      );
      await closeDialog();

      // ── Завершённая: «Перейти» — в её разговор ───────────────────────────────
      await button('Перейти', 'finished').click();
      await page.waitForURL(/\/chat\?id=/, { timeout: 30_000 }).catch(() => undefined);
      check(
        'завершённая: «Перейти» открывает её разговор',
        page.url().includes(`/chat?id=${IDS.finished}`),
        page.url(),
      );
      await page.goto(`${stand.webUrl}/analytics?tab=sessions`, { waitUntil: 'domcontentloaded' });
      await button('Остановить', 'running').waitFor({ timeout: 30_000 });

      // ── Стоп процесса: окно называет цель, снимает дерево, итог по факту ─────
      await button('Остановить', 'running').click();
      await dialog.getByText('Остановить сессию?').waitFor({ timeout: 30_000 });
      const stopText = await dialog.innerText();
      check(
        'стоп: окно называет номер, место, команду и каталог',
        stopText.includes(`Будет снят процесс ${running.child.pid} (в терминале — вне панели)`) &&
          stopText.includes(`claude.js --resume ${IDS.running}`) &&
          stopText.includes(projects.running),
        stopText.replace(/\s+/g, ' '),
      );
      check('стоп: предупреждения про панель нет', !stopText.includes('сама панель'));
      if (SHOTS) await dialog.screenshot({ path: join(SHOTS, '03-stop-confirm.png') });
      const kidPid = running.kid();
      await dialog.getByRole('button', { name: 'Остановить', exact: true }).click();
      const stopped = page.getByText(/^Сессия остановлена: снято 2 процесса$/);
      await stopped
        .first()
        .waitFor({ timeout: 30_000 })
        .catch(() => undefined);
      check(
        'стоп: итог словами — снято 2 процесса',
        (await stopped.count()) === 1,
        `${await stopped.count()} копий`,
      );
      const exitedInTime = await Promise.race([
        running.exited.then(() => true),
        wait(5000).then(() => false),
      ]);
      check('стоп: процесс сессии завершён', exitedInTime);
      check('стоп: потомок снят вместе с ним', !alive(kidPid), `потомок ${kidPid}`);
      if (SHOTS) await page.screenshot({ path: join(SHOTS, '04-stopped.png') });

      // ── Процесс исчез между окном и подтверждением ───────────────────────────
      await wait(1000);
      await button('Остановить', 'gone').click();
      await dialog.getByText('Остановить сессию?').waitFor({ timeout: 30_000 });
      check(
        'ушедший: окно назвало его номер',
        (await dialog.innerText()).includes(`процесс ${gone.child.pid}`),
      );
      const goneKid = gone.kid();
      gone.child.kill();
      process.kill(goneKid);
      await gone.exited;
      await dialog.getByRole('button', { name: 'Остановить', exact: true }).click();
      const goneToast = page.getByText(
        `Процесса ${gone.child.pid} уже нет — сессия завершилась сама`,
      );
      await goneToast
        .first()
        .waitFor({ timeout: 30_000 })
        .catch(() => undefined);
      check(
        'ушедший: честное «процесса уже нет», а не «остановлено»',
        (await goneToast.count()) === 1,
      );

      // ── Чат панели: «Перейти» — в сам чат, «Остановить» — стоп чата ─────────
      const panelProject = join(stand.root, 'qa-panel');
      mkdirSync(panelProject, { recursive: true });
      const chatId = randomUUID();
      // Ответ на отправку — поток прогона до его конца; ждём его только после стопа.
      const sending = stand.api('/chat/send', {
        method: 'POST',
        body: { chatId, prompt: 'задача qa-panel', projectPath: panelProject },
      });
      sending.catch(() => undefined);
      const activeRun = async () => {
        const res = await stand.api('/chat/active');
        const runs = res.status === 200 ? JSON.parse(res.text) : [];
        return runs.find((run) => run.chatId === chatId && run.status === 'running');
      };
      // Номер сессии прогон узнаёт из строки init — до неё транскрипта ещё нет.
      const namedRun = async () => {
        const found = await activeRun();
        return found?.sessionId ? found : undefined;
      };
      let run;
      for (let tries = 0; tries < 60 && !run; tries++) {
        run = await namedRun();
        if (!run) await wait(500);
      }
      check('чат панели: прогон идёт', Boolean(run), JSON.stringify(run ?? null));
      // Отчёт аналитики сервер держит минуту; свежий транскрипт — через refresh,
      // как кнопкой обновления.
      await stand.api('/analytics?days=today&refresh=true');

      await page.goto(`${stand.webUrl}/analytics?tab=sessions`, { waitUntil: 'domcontentloaded' });
      await button('Перейти', 'panel')
        .waitFor({ timeout: 30_000 })
        .catch(() => undefined);
      check(
        'чат панели: строка с «Перейти» есть',
        (await button('Перейти', 'panel').count()) === 1,
        `${JSON.stringify(run ?? null)} | ${(
          await page
            .getByRole('button', { name: /^Перейти: / })
            .evaluateAll((nodes) =>
              nodes.map((node) => node.getAttribute('aria-label') ?? node.textContent),
            )
        ).join(' ; ')}`,
      );
      await button('Перейти', 'panel').click();
      await page.waitForURL(/\/chat\?id=/, { timeout: 30_000 }).catch(() => undefined);
      check(
        'чат панели: «Перейти» открывает сам чат, а не окно «где идёт»',
        page.url().includes(`/chat?id=${chatId}`),
        page.url(),
      );

      await page.goto(`${stand.webUrl}/analytics?tab=sessions`, { waitUntil: 'domcontentloaded' });
      await button('Остановить', 'panel').waitFor({ timeout: 30_000 });
      await button('Остановить', 'panel').click();
      await dialog.getByText('Остановить сессию?').waitFor({ timeout: 30_000 });
      const panelStop = await dialog.innerText();
      check(
        'чат панели: окно называет стоп чата, а не снятие процесса',
        /Остановится прогон чата панели в «[^»]*qa-panel»/.test(panelStop) &&
          !panelStop.includes('Будет снят процесс') &&
          !panelStop.includes('сама панель'),
        panelStop.replace(/\s+/g, ' '),
      );
      if (SHOTS) await dialog.screenshot({ path: join(SHOTS, '05-panel-stop.png') });
      await dialog.getByRole('button', { name: 'Остановить', exact: true }).click();
      const chatStopped = page.getByText('Чат панели остановлен');
      await chatStopped
        .first()
        .waitFor({ timeout: 30_000 })
        .catch(() => undefined);
      check('чат панели: итог словами — «Чат панели остановлен»', (await chatStopped.count()) >= 1);
      let still = await activeRun();
      for (let tries = 0; tries < 20 && still; tries++) {
        await wait(500);
        still = await activeRun();
      }
      check('чат панели: прогон действительно остановлен', !still, JSON.stringify(still ?? null));
      const sent = await Promise.race([sending, wait(10_000).then(() => undefined)]);
      check(
        'чат панели: поток отправки закрылся после стопа',
        sent?.status === 200,
        String(sent?.status),
      );

      check(
        'страница без необработанных ошибок',
        page.errors.length === 0,
        page.errors.join(' | '),
      );
    } finally {
      await browser.close();
    }
  },
);
