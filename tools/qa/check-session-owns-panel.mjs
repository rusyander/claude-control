/**
 * Кейс settings-models-010: «Аналитика → Сессии → Остановить» у сессии, из
 * которой запущена САМА панель, предупреждает, что остановится и панель, и
 * снимает её только после этого явного согласия.
 *
 * Как это устроено по-настоящему: человек в терминале с `claude` запускает
 * `pnpm dev` — сервер панели становится потомком процесса сессии, и снятие
 * процесса деревом уносит панель. Сервер узнаёт это по своим предкам
 * (`panelAncestors`) и отдаёт `ownsPanel`; окно стопа говорит об этом и
 * меняет кнопку на «Остановить вместе с панелью».
 *
 * Здесь та же родословная, без настоящего CLI: проверка пишет во временный
 * каталог `claude.js` (имя, по которому панель признаёт агента), запускает его
 * как `claude.js --resume <id>`, и уже ОН поднимает одноразовый стенд
 * (`throwaway-stand.mjs`) — сервер панели его потомок. Транскрипт сессии лежит
 * в каталоге конфигурации стенда. Настоящий `~/.claude` и стенд человека не
 * затрагиваются; снимается только дерево, запущенное этой проверкой.
 *
 * Шаги:
 *  1. окно стопа: предупреждение о панели и кнопка «вместе с панелью»;
 *  2. «Отмена» — процесс сессии и панель живы;
 *  3. гонка: окно не знало о панели (`ownsPanel` подменён на false в ответе
 *     locate) — сервер отказывает `owns-panel`, окно просит подтвердить ещё раз,
 *     процесс жив;
 *  4. подтверждение — процесс сессии снят вместе с панелью.
 *
 * `SHOTS=<каталог>` — снимки окна. Запуск: `node tools/qa/check-session-owns-panel.mjs`.
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright';
import { REPO, reporter, wait } from './throwaway-stand.mjs';

const SESSION = '55555555-5555-4555-8555-555555555555';
const SHOTS = process.env.SHOTS;
if (SHOTS) mkdirSync(SHOTS, { recursive: true });

/**
 * «Сессия CLI», поднимающая стенд. Путь к ней — во временном каталоге, не в
 * репозитории: процессы с именем репозитория в команде панель отсеивает как свои.
 */
const LAUNCHER = String.raw`
const { mkdirSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');
const [, , , sessionId, infoFile] = process.argv;
const standUrl = process.env.QA_STAND_MODULE;
import(standUrl).then(async ({ startStand }) => {
  const stand = await startStand({
    label: 'owns-panel',
    seed: ({ cfg, home }) => {
      const project = join(home, 'qa-owner');
      mkdirSync(project, { recursive: true });
      const dir = join(cfg, 'projects', project.replace(/[^a-zA-Z0-9]/g, '-'));
      mkdirSync(dir, { recursive: true });
      const base = { sessionId, cwd: project, timestamp: new Date().toISOString(), gitBranch: 'main' };
      const lines = [
        { ...base, type: 'user', message: { role: 'user', content: 'задача qa-owner' } },
        { ...base, type: 'assistant', requestId: 'req-owner', message: { id: 'msg-owner', role: 'assistant',
          model: 'claude-sonnet-4-5', content: [{ type: 'text', text: 'запускаю панель' }],
          usage: { input_tokens: 100, output_tokens: 20 } } },
      ];
      writeFileSync(join(dir, sessionId + '.jsonl'), lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
    },
  });
  writeFileSync(infoFile, JSON.stringify({ root: stand.root, webUrl: stand.webUrl, apiUrl: stand.apiUrl }));
  process.stdin.on('end', () => stand.stop().then(() => process.exit(0)));
  process.stdin.resume();
}, (error) => {
  writeFileSync(infoFile, JSON.stringify({ error: String(error) }));
  process.exit(1);
});
`;

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const { check, finish } = reporter();
const dir = mkdtempSync(join(tmpdir(), 'qa-owns-'));
const launcher = join(dir, 'claude.js');
const infoFile = join(dir, 'stand.json');
writeFileSync(launcher, LAUNCHER, 'utf8');
// Адрес модуля стенда — переменной окружения, а не аргументом: в нём имя
// репозитория, и панель отсеяла бы такую команду как свою.
const session = spawn(process.execPath, [launcher, '--resume', SESSION, infoFile], {
  stdio: ['pipe', 'ignore', 'inherit'],
  env: {
    ...process.env,
    QA_STAND_MODULE: pathToFileURL(join(REPO, 'tools', 'qa', 'throwaway-stand.mjs')).href,
  },
});
const exited = new Promise((done) => session.once('exit', done));

let info;
let browser;
try {
  for (let i = 0; i < 240 && !existsSync(infoFile); i += 1) await wait(500);
  info = existsSync(infoFile) ? JSON.parse(readFileSync(infoFile, 'utf8')) : undefined;
  if (!info?.webUrl) throw new Error(`стенд не поднялся: ${JSON.stringify(info)}`);
  console.log(`Сессия-родитель PID ${session.pid}, панель ${info.apiUrl}, фронт ${info.webUrl}\n`);

  browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(`${info.webUrl}/analytics?tab=sessions`, { waitUntil: 'domcontentloaded' });
  const stop = page.getByRole('button', { name: /^Остановить: .*qa-owner$/ });
  await stop.waitFor({ timeout: 60_000 });
  const dialog = page.getByRole('dialog');
  const confirmWithPanel = dialog.getByRole('button', { name: 'Остановить вместе с панелью' });
  const confirmPlain = dialog.getByRole('button', { name: 'Остановить', exact: true });

  // 1. Окно стопа знает о панели.
  await stop.click();
  await dialog.getByText('Остановить сессию?').waitFor({ timeout: 30_000 });
  await dialog
    .getByText(`процесс ${session.pid}`, { exact: false })
    .waitFor({ timeout: 20_000 })
    .catch(() => undefined);
  const text = (await dialog.innerText()).replace(/\s+/g, ' ');
  check('окно стопа называет процесс сессии', text.includes(`процесс ${session.pid}`), text);
  check(
    'окно стопа предупреждает, что остановится панель',
    text.includes('Из этой сессии запущена сама панель'),
    text,
  );
  check('кнопка — «Остановить вместе с панелью»', (await confirmWithPanel.count()) === 1);
  check('простой «Остановить» не предложен', (await confirmPlain.count()) === 0);
  if (SHOTS) await dialog.screenshot({ path: join(SHOTS, '01-owns-panel.png') });

  // 2. Отмена ничего не снимает.
  await dialog.getByRole('button', { name: 'Отмена' }).click();
  await dialog.waitFor({ state: 'hidden', timeout: 5000 });
  await wait(1000);
  check('«Отмена»: процесс сессии жив', alive(session.pid));
  const health = await fetch(`${info.apiUrl}/api/location`).then(
    (res) => res.status,
    () => 0,
  );
  check('«Отмена»: панель отвечает', health === 200, String(health));

  // 3. Гонка: окно не знало о панели — сервер отказывает, окно переспрашивает.
  await page.route('**/api/analytics/sessions/*/where', async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    if (body?.where?.kind === 'process') body.where.ownsPanel = false;
    await route.fulfill({ response, json: body });
  });
  await stop.click();
  await dialog.getByText('Остановить сессию?').waitFor({ timeout: 30_000 });
  check(
    'гонка: окно без предупреждения предлагает простой стоп',
    (await confirmPlain.count()) === 1,
  );
  await confirmPlain.click();
  await dialog.getByRole('alert').waitFor({ timeout: 30_000 });
  const asked = (await dialog.innerText()).replace(/\s+/g, ' ');
  check(
    'гонка: сервер отказал, окно просит подтвердить ещё раз',
    asked.includes('Из этой сессии запущена панель — подтвердите остановку ещё раз'),
    asked,
  );
  check('гонка: кнопка стала «вместе с панелью»', (await confirmWithPanel.count()) === 1);
  check('гонка: процесс сессии жив после отказа', alive(session.pid));
  if (SHOTS) await dialog.screenshot({ path: join(SHOTS, '02-owns-panel-asked.png') });

  // 4. Согласие — снимается сессия вместе с панелью.
  await confirmWithPanel.click();
  const gone = await Promise.race([exited.then(() => true), wait(30_000).then(() => false)]);
  check('подтверждение: процесс сессии снят', gone && !alive(session.pid));
  await wait(2000);
  const after = await fetch(`${info.apiUrl}/api/location`).then(
    (res) => res.status,
    () => 0,
  );
  check('подтверждение: панель остановилась вместе с сессией', after === 0, String(after));
  check('страница без необработанных ошибок', errors.length === 0, errors.join(' | '));
} catch (error) {
  check('сценарий дошёл до конца', false, String(error?.stack ?? error).split('\n')[0]);
} finally {
  await browser?.close();
  if (alive(session.pid)) {
    session.stdin.end();
    await Promise.race([exited, wait(15_000)]);
    if (alive(session.pid)) session.kill();
  }
  await wait(1000);
  if (info?.root) rmSync(info.root, { recursive: true, force: true, maxRetries: 5 });
  rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
}
finish();
