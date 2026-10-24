#!/usr/bin/env node
/**
 * Живое доказательство ворот «решает только человек» (D-S01, RF-DS-01..05) — на
 * настоящих сокетах одноразовой панели.
 *
 * Кому верят ворота: вызову изнутри панели (`app.inject`, сокета нет), браузеру
 * человека (образ НАСТОЯЩЕЙ установки, у корня браузера нет ключей автоматизации,
 * прогона среди предков нет) и прокси Tailscale этой машины. Остальные — 403.
 *
 * Строки. Отказы бьют в ОЖИДАЮЩУЮ запись D-2, и после них она обязана ждать —
 * это читается на сервере, а не из ответа: (1) процесс, запустивший панель, —
 * прежде доверенный, теперь нет (RF-DS-05); (2) отвязанный от дерева помощник;
 * (3) свой адрес в `X-Forwarded-For`; (4) адрес tailnet с ключом без прокси;
 * (6) Chromium Playwright и (7) установленный Chrome под Playwright — ключи
 * автоматизации у корня. Строка (8) — человек: УСТАНОВЛЕННЫЙ Chrome (или Edge)
 * без ключей, профиль вне временного каталога, страница с origin стенда
 * (`/@fs/…/fixtures/human-gate-harness.html` через Vite) шлёт решение по D-1, и
 * сервер показывает D-1 `allowed`. Строки (9–10) — маршруты `human:*` журнала,
 * которые прежде были открыты (ответы Telegram, импорт настроек): 403 и файлы
 * стенда не тронуты.
 *
 * Два стенда. Строки 1–10 идут на СТРОГОМ стенде: его каталоги — в `.agent/tmp`
 * репозитория, вне temp ОС, и шов одноразового стенда (`throwaway-stand.ts`)
 * закрыт — ворота судят как на настоящей панели. Строки S1–S4 — на обычном
 * стенде в temp ОС, где шов открыт: проверка, поднявшая панель, и Chromium
 * Playwright решают, а отвязанный помощник и подделка tailnet — всё равно 403.
 *
 * Запуск: node tools/qa/check-deferred-human-gate.mjs [--no-browser]
 * `--no-browser` пропускает строки 6–8 (сеанс без рабочего стола).
 * `DEFERRED_SERVER_DIR` — каталог копии `apps/server` вместо рабочего (мутанты).
 * Выход 0 — всё сошлось, 1 — расхождения, 2 — стенд или браузер не поднялись.
 * Настоящий `~/.claude` и стенд человека (:5178/:8888) не трогаются; окно
 * браузера снимается по номеру процесса.
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { networkInterfaces, tmpdir, userInfo } from 'node:os';
import { killProcessTree } from '../../apps/server/src/lib/kill-tree.mjs';
import { NotChecked, REPO, reporter, startStand, wait } from './throwaway-stand.mjs';

const { check, finish } = reporter();
const BODY = { behavior: 'allow', via: 'web' };
const withBrowser = !process.argv.includes('--no-browser');
const HUMAN_ID = 'D-1';
const TARGET_ID = 'D-2';
const DECISION = `/chat/deferred/${TARGET_ID}/decision`;
const HARNESS = join(REPO, 'tools', 'qa', 'fixtures', 'human-gate-harness.html');

/** Запись, ждущая решения, — так её пишет сама панель (`deferred-asks.json`). */
function waitingRecord(id, command) {
  const now = Date.now();
  return {
    id,
    state: 'waiting',
    kind: 'permission',
    scope: { kind: 'chat', chatKeys: ['qa-human-gate'] },
    runKeys: ['qa-human-gate'],
    toolName: 'Bash',
    input: { command },
    hash: `qa-${id}`,
    reason: 'qa: human gate',
    askedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + 86_400_000).toISOString(),
    source: { chatTitle: 'qa human gate' },
  };
}

/** Адрес этой машины не из loopback — его и подставляет модель в `X-Forwarded-For`. */
function ownAddress() {
  for (const list of Object.values(networkInterfaces())) {
    for (const entry of list ?? []) {
      if (entry.family === 'IPv4' && !entry.internal) return entry.address;
    }
  }
  return undefined;
}

/** Установленный браузер: только системные каталоги программ (стенд меняет LOCALAPPDATA). */
function installedBrowser() {
  const candidates =
    process.platform === 'win32'
      ? [process.env.ProgramFiles, process.env['ProgramFiles(x86)'], process.env.ProgramW6432]
          .filter(Boolean)
          .flatMap((root) => [
            join(root, 'Google', 'Chrome', 'Application', 'chrome.exe'),
            join(root, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
          ])
      : process.platform === 'darwin'
        ? [
            '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
            '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
          ]
        : [
            '/opt/google/chrome/chrome',
            '/usr/lib/chromium/chromium',
            '/opt/microsoft/msedge/msedge',
          ];
  return candidates.find((path) => existsSync(path));
}

/**
 * Запрос из процесса, отвязанного от дерева: посредник спавнит внука и сразу
 * выходит, поэтому у внука нет живого родителя — та форма, которой помощник
 * модели проходил прежние ворота. Ответ внук пишет в файл.
 */
async function fromDetached(apiUrl) {
  const dir = mkdtempSync(join(tmpdir(), 'cc-gate-'));
  const out = join(dir, 'answer.json');
  const grandchild = [
    `fetch(${JSON.stringify(`${apiUrl}/api${DECISION}`)}, {`,
    " method: 'POST', headers: { 'content-type': 'application/json' },",
    ` body: ${JSON.stringify(JSON.stringify(BODY))} })`,
    ' .then(async (r) => ({ status: r.status, body: await r.text() }),',
    '  (e) => ({ status: 0, body: String(e) }))',
    ` .then((a) => require('fs').writeFileSync(${JSON.stringify(out)}, JSON.stringify(a)));`,
  ].join('');
  const middle = [
    `const c = require('child_process').spawn(process.execPath, ['-e', ${JSON.stringify(grandchild)}],`,
    " { detached: true, stdio: 'ignore' }); c.unref(); process.exit(0);",
  ].join('');
  await new Promise((done) => {
    const child = spawn(process.execPath, ['-e', middle], { stdio: 'ignore' });
    child.on('exit', done);
  });
  for (let waited = 0; waited < 60 && !existsSync(out); waited += 1) await wait(250);
  if (!existsSync(out)) throw new NotChecked('отвязанный процесс не ответил');
  const answer = JSON.parse(readFileSync(out, 'utf8'));
  rmSync(dir, { recursive: true, force: true });
  return answer;
}

/** Решение со страницы стенда в браузере Playwright (`channel` — его сборка или установленный). */
async function fromPlaywright(webUrl, channel) {
  const { chromium } = await import('playwright');
  const browser = await chromium.launch({ channel });
  try {
    const page = await browser.newPage();
    await page.goto(webUrl);
    return await page.evaluate(
      async ([path, body]) => {
        const res = await fetch(path, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body,
        });
        return { status: res.status, body: await res.text() };
      },
      [`/api${DECISION}`, JSON.stringify(BODY)],
    );
  } finally {
    await browser.close();
  }
}

/**
 * Человек: установленный браузер запускается так, как его запускает ОС, — без
 * ключей автоматизации, со своим профилем ВНЕ временного каталога (профиль в
 * temp — признак одноразового браузера, ворота его отбивают). Профиль — в
 * `.agent/tmp` репозитория (вне git), снимается после строки.
 */
async function fromInstalledBrowser(stand, program) {
  const profile = join(REPO, '.agent', 'tmp', `qa-human-gate-profile-${process.pid}`);
  mkdirSync(profile, { recursive: true });
  const url = `${stand.webUrl}/@fs/${HARNESS.replace(/\\/g, '/')}?id=${HUMAN_ID}&behavior=allow`;
  const spawnedAt = Date.now();
  const browser = spawn(
    program,
    [
      `--user-data-dir=${profile}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--window-size=480,320',
      url,
    ],
    { stdio: 'ignore', detached: false },
  );
  try {
    for (let waited = 0; waited < 120; waited += 1) {
      const list = await stand.api('/chat/deferred');
      const item = list.body?.items?.find((entry) => entry.id === HUMAN_ID);
      if (item && item.state !== 'waiting') return item;
      await wait(250);
    }
    return undefined;
  } finally {
    // Дерево браузера — по номеру его корня, без поиска по имени.
    if (browser.pid) killProcessTree(browser.pid, { spawnedAt });
    await wait(1500);
    rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
  }
}

const serverDir = process.env.DEFERRED_SERVER_DIR;
const seed = ({ cfg }) => {
  const records = [
    waitingRecord(HUMAN_ID, 'echo qa-human'),
    waitingRecord(TARGET_ID, 'echo qa-target'),
  ];
  writeFileSync(
    join(cfg, 'agentdeck', 'deferred-asks.json'),
    `${JSON.stringify({ version: 1, next: 3, records })}\n`,
  );
};
const standOptions = (label) => ({
  label,
  web: withBrowser,
  seed,
  ...(serverDir ? { serverDir } : {}),
});

/**
 * Строгий стенд: `mkdtemp` стенда берёт `os.tmpdir()`, поэтому TEMP/TMP/TMPDIR
 * этого процесса на один синхронный вызов указывают в `.agent/tmp` репозитория,
 * а панели стенда передаётся настоящий temp. Шов судит по учётной записи ОС, не
 * по окружению, — каталоги стенда вне temp, шов закрыт.
 */
function strictStand() {
  const outside = join(REPO, '.agent', 'tmp', 'qa-gate-tmp');
  mkdirSync(outside, { recursive: true });
  const names = ['TEMP', 'TMP', 'TMPDIR'];
  const saved = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  const real = Object.fromEntries(
    names.filter((name) => saved[name]).map((name) => [name, saved[name]]),
  );
  for (const name of names) process.env[name] = outside;
  try {
    return startStand({ ...standOptions('gate'), env: real });
  } finally {
    for (const name of names) {
      if (saved[name] === undefined) delete process.env[name];
      else process.env[name] = saved[name];
    }
  }
}

/** Корень temp ОС — как его видит шов (`osTempRoots`), без окружения. */
const OS_TEMP =
  process.platform === 'win32' ? join(userInfo().homedir, 'AppData', 'Local', 'Temp') : '/tmp';
const inTemp = (path) => path.toLowerCase().startsWith(OS_TEMP.toLowerCase());

const stateOf = async (on, id) =>
  (await on.api('/chat/deferred')).body?.items?.find((item) => item.id === id)?.state;
const decide = (on, id, headers) =>
  on.api(`/chat/deferred/${id}/decision`, { method: 'POST', body: BODY, headers });
const parsed = (answer) => {
  if (typeof answer.body !== 'string') return answer.body;
  try {
    return JSON.parse(answer.body || '{}');
  } catch {
    return { raw: answer.body };
  }
};
const show = (answer) => `${answer.status} ${JSON.stringify(parsed(answer)).slice(0, 200)}`;
const tailnet = { 'x-forwarded-for': '100.101.1.2', authorization: 'Bearer forged' };
const [DEVICE, REMOTE] = ['decision_device_unverified', 'decision_remote_unverified'];
/** Отказ 403 с этим кодом (и, если задано, нетронутые файлы стенда). */
const deny = (label, answer, code, intact = true) =>
  check(
    `${label}: 403 ${code}`,
    answer.status === 403 && parsed(answer)?.code === code && intact,
    show(answer),
  );
const read = (file) => (existsSync(file) ? readFileSync(file, 'utf8') : undefined);

const stand = await strictStand();
try {
  console.log(`  строгий стенд ${stand.apiUrl}: ${stand.cfg}`);
  check('каталоги строгого стенда — вне temp ОС (шов закрыт)', !inTemp(stand.cfg), stand.cfg);
  const both = [await stateOf(stand, HUMAN_ID), await stateOf(stand, TARGET_ID)];
  check('обе записи ждут решения до проверки', both.join() === 'waiting,waiting', both.join());

  // 1. Процесс, запустивший панель, — больше не доверенный (RF-DS-05).
  deny('запустивший панель отбит', await decide(stand, TARGET_ID), DEVICE);
  // 2. Отвязанный помощник.
  deny('отвязанный от дерева процесс отбит', await fromDetached(stand.apiUrl), DEVICE);
  // 3. Подделанный `X-Forwarded-For` с адресом самой машины.
  const own = ownAddress();
  if (own) {
    const forged = { 'x-forwarded-for': own, authorization: 'Bearer forged' };
    deny(
      `свой адрес в X-Forwarded-For (${own}) отбит`,
      await decide(stand, TARGET_ID, forged),
      'decision_human_only',
    );
  } else {
    console.log('  — своего адреса вне loopback нет: подделку XFF не проверяем');
  }
  // 4. Адрес сети Tailscale с ключом, но без прокси этой машины на том конце.
  deny(
    'ключ и адрес tailnet без прокси Tailscale отбиты',
    await decide(stand, TARGET_ID, tailnet),
    REMOTE,
  );

  // 5. Список D-n неузнанному читателю отдаётся: телефон и Telegram без него слепы.
  const list = await stand.api('/chat/deferred');
  check('список D-n читается: 200', list.status === 200, `${list.status}`);

  if (withBrowser) {
    // 6–7. Браузер под Playwright: своя сборка и установленный Chrome — отказ.
    deny('Chromium Playwright отбит', await fromPlaywright(stand.webUrl, 'chromium'), DEVICE);
    const program = installedBrowser();
    if (!program) throw new NotChecked('установленного Chrome/Edge нет: строки 7–8 не проверены');
    const channel = program.toLowerCase().includes('edge') ? 'msedge' : 'chrome';
    const driven = await fromPlaywright(stand.webUrl, channel).catch((error) => ({
      status: 0,
      body: String(error),
    }));
    deny('установленный браузер под Playwright (ключи автоматизации) отбит', driven, DEVICE);

    // 8. Человек: установленный браузер без ключей, страница стенда.
    const item = await fromInstalledBrowser(stand, program);
    check(
      `установленный браузер без ключей решил ${HUMAN_ID}: на сервере allowed, via web`,
      item?.state === 'allowed' && item?.decidedVia === 'web',
      JSON.stringify(item ?? 'нет решения за 30 с').slice(0, 200),
    );
  }
  const target = await stateOf(stand, TARGET_ID);
  check(`после всех отказов ${TARGET_ID} всё ещё ждёт`, target === 'waiting', target);

  // 9–10. Маршруты `human:*`, прежде открытые по HTTP (RF-DS-01/02). Файл ответов
  // панель пишет уже при старте — судится его содержимое, а не наличие.
  const answersFile = join(stand.cfg, 'agentdeck', 'telegram-answers.json');
  const answersBefore = read(answersFile);
  const bot = await stand.api('/integrations/telegram/answers', {
    method: 'PUT',
    body: { enabled: true, ownerId: '999000111', token: `123456:${'A'.repeat(35)}` },
  });
  deny(
    'свой бот Telegram от не-браузера, файл ответов не изменён',
    bot,
    DEVICE,
    read(answersFile) === answersBefore,
  );
  const stateFile = join(stand.cfg, 'agentdeck', 'state.json');
  const stateBefore = read(stateFile);
  const flip = await stand.api('/settings/import', {
    method: 'POST',
    body: { settings: { chatAutoMode: true } },
  });
  deny(
    'импорт chatAutoMode от не-браузера, state.json не изменён',
    flip,
    DEVICE,
    read(stateFile) === stateBefore,
  );
} finally {
  await stand.stop();
}

// S1–S4. Одноразовый стенд в temp ОС: шов открыт — но только для проверки,
// поднявшей панель, и браузера автоматизации.
const seam = await startStand(standOptions('gate-seam'));
try {
  console.log(`  стенд в temp ${seam.apiUrl}: ${seam.cfg}`);
  check('каталоги стенда — в temp ОС (шов открыт)', inTemp(seam.cfg), seam.cfg);
  const self = await decide(seam, HUMAN_ID);
  const human = await stateOf(seam, HUMAN_ID);
  check(
    `S1 поднявшая панель проверка решила ${HUMAN_ID}`,
    self.status === 200 && human === 'allowed',
    show(self),
  );
  deny('S2 отвязанный помощник и на стенде в temp отбит', await fromDetached(seam.apiUrl), DEVICE);
  deny('S3 подделка tailnet шва не получает', await decide(seam, TARGET_ID, tailnet), REMOTE);
  if (withBrowser) {
    const bundled = await fromPlaywright(seam.webUrl, 'chromium');
    const target = await stateOf(seam, TARGET_ID);
    check(
      `S4 Chromium Playwright решил ${TARGET_ID}`,
      bundled.status === 200 && target === 'allowed',
      show(bundled),
    );
  } else {
    check(`S2–S3 ${TARGET_ID} ждёт`, (await stateOf(seam, TARGET_ID)) === 'waiting');
  }
} finally {
  await seam.stop();
}
finish();
