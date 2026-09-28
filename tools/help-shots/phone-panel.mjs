/**
 * Кадры панели для документа «Телефон»: `phone/pair` 01–03 — карточка
 * «Удалённый доступ» выключенной, с включённым токеном и с кодом спаривания.
 * Четыре варианта за прогон: тема (светлая, тёмная) × язык (ru, en).
 *
 * СТЕНД ОДНОРАЗОВЫЙ: дом, `~/.claude` и `~/.agentdeck` (там ляжет токен этой
 * панели) — во временном каталоге, который в конце удаляется. Фронт запускается
 * с ТЕМ ЖЕ домом, что и сервер: при включённом «Пускать по токену» dev-прокси
 * читает токен из `~/.agentdeck/api-token` своего дома, и с настоящим домом он
 * понёс бы на одноразовую панель токен человека.
 *
 * ПОДМЕНЁН ОДИН ОТВЕТ — адрес, найденный у Tailscale. Сервер спрашивает
 * `tailscale` на этой машине (на Windows — по абсолютному пути, мимо PATH), и
 * настоящий ответ — имя машины съёмки в её tailnet. В кадр оно не должно попасть
 * ни текстом, ни подсказкой поля ввода, поэтому `detectedUrl` в ответе
 * `/api/remote` заменён выдуманным, а текст адреса в кадре ещё и замазан (правило
 * каталога снимков краснеет на любом чужом домене в тексте кадра).
 *
 * ТОКЕН В КАДР НЕ ПОПАДАЕТ даже одноразовый: строка токена под кодом замазана,
 * а сам QR-код размыт до нечитаемого — в нём тот же токен.
 *
 * Запуск: node tools/help-shots/phone-panel.mjs
 * Переменные: GUIDE_PANEL_PORT (5317), GUIDE_WEB_PORT (9017).
 */
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createConnection } from 'node:net';
import { join } from 'node:path';
import { hostname, tmpdir, userInfo } from 'node:os';
import { chromium } from 'playwright';
import {
  DEFAULT_MASKS,
  REPO_ROOT,
  SHOT_LANGS,
  SHOT_THEMES,
  applyShotLanguage,
  openScenario,
  writeVariantIndex,
} from './kit.mjs';
import {
  EXTERNAL_URL,
  bringIntoView,
  card,
  openSettingsTab,
  patchSettings,
} from './access-providers-fixture.mjs';

const PANEL_PORT = Number(process.env.GUIDE_PANEL_PORT ?? 5317);
const WEB_PORT = Number(process.env.GUIDE_WEB_PORT ?? 9017);
const PANEL = `http://127.0.0.1:${PANEL_PORT}`;
const WEB = `http://127.0.0.1:${WEB_PORT}`;
const IS_WIN = process.platform === 'win32';
/** Выдуманный адрес машины в tailnet — вместо того, что нашёл настоящий Tailscale. */
const SHOWN_ADDRESS = 'https://desk.tailnet-example.ts.net';
const REMOTE_CARD = card('Удалённый доступ');
const MASKS = [...DEFAULT_MASKS, EXTERNAL_URL];

const wait = (ms) => new Promise((done) => setTimeout(done, ms));

/** Порт занят кем-то — стенд не поднимается поверх чужого. */
function portBusy(port) {
  return new Promise((resolve) => {
    const socket = createConnection({ host: '127.0.0.1', port });
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('error', () => resolve(false));
  });
}

async function waitFor(url, seconds, headers = {}) {
  for (let i = 0; i < seconds * 2; i += 1) {
    try {
      const res = await fetch(url, { headers });
      if (res.status < 500) return true;
    } catch {
      /* ещё не поднялось */
    }
    await wait(500);
  }
  return false;
}

/** PATCH /api/remote напрямую, с токеном: при включённом доступе без него 401. */
async function patchRemote(body, token) {
  const res = await fetch(`${PANEL}/api/remote`, {
    method: 'PATCH',
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`PATCH /api/remote: ${res.status}`);
  return res.json();
}

/** Гасим ровно своего ребёнка по его PID — без обхода дерева (он однажды снёс чужой стенд). */
function stopChild(child) {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
  child.kill();
}

/**
 * Страж утечки: имя машины съёмки не должно стоять в кадре НИГДЕ — ни в тексте,
 * ни в подсказке или значении поля, ни в атрибутах. Маска закрывает только
 * текст, поэтому первый прогон пропустил адрес в `placeholder`; теперь такой
 * кадр не пишется вовсе.
 */
async function assertNoLeak(page, secrets) {
  if (secrets.length === 0) throw new Error('страж утечки без образцов: проверять нечем');
  // Проверяется то, что попадает в кадр, — карточка, а не вся страница.
  const found = await page
    .locator(REMOTE_CARD)
    .first()
    .evaluate((card, needles) => {
      const html = card.outerHTML;
      const values = [...card.querySelectorAll('input, textarea')].map(
        (node) => `${node.value} ${node.placeholder}`,
      );
      const hay = [html, ...values].join(' ');
      return needles.filter((needle) => hay.includes(needle));
    }, secrets);
  if (found.length > 0)
    throw new Error(`в кадр просочилось: ${found.length} значение(й) машины съёмки`);
}

async function shoot(browser, scenario, token, secrets) {
  const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
  // Настоящий ответ панели, в котором заменён только адрес от Tailscale. Любой
  // метод, не один GET: карточка кладёт ответ PATCH прямо в кэш, и после тумблера
  // в подсказке поля оказывалось имя машины съёмки — так и попало в первый прогон.
  await page.route(
    (url) => url.pathname.startsWith('/api/remote'),
    async (route) => {
      const response = await route.fetch();
      const type = response.headers()['content-type'] ?? '';
      if (!type.includes('application/json')) return route.fulfill({ response });
      const body = await response.json();
      const rewritten =
        body && typeof body === 'object' && 'detectedUrl' in body
          ? { ...body, detectedUrl: SHOWN_ADDRESS, serveActive: true }
          : body;
      await route.fulfill({ response, json: rewritten });
    },
  );
  try {
    // ── 01. Выключенный ──────────────────────────────────────────────────────
    await openSettingsTab(page, WEB, 'access', 2500);
    await bringIntoView(page, REMOTE_CARD, 28);
    await assertNoLeak(page, secrets);
    await scenario.shot(page, '01-remote-off', { clip: REMOTE_CARD, padding: 20, maskText: MASKS });

    // ── 02. «Пускать по токену» ──────────────────────────────────────────────
    // Тумблер карточки — тот же путь, что у человека. С этого момента каждый
    // запрос страницы идёт с токеном, который подставляет dev-прокси.
    await page
      .locator(REMOTE_CARD)
      .getByRole('switch', { name: /^(Пускать по токену|Require a token)/ })
      .first()
      .click();
    await page
      .locator(REMOTE_CARD)
      .getByText(/^(включён|on)$/)
      .first()
      .waitFor();
    await page.waitForTimeout(800);
    await bringIntoView(page, REMOTE_CARD, 28);
    await assertNoLeak(page, secrets);
    await scenario.shot(page, '02-remote-on', { clip: REMOTE_CARD, padding: 20, maskText: MASKS });

    // ── 03. Код спаривания ───────────────────────────────────────────────────
    await page
      .locator(REMOTE_CARD)
      .getByRole('button', { name: /^(Показать код спаривания|Show pairing code)$/ })
      .click();
    await page.locator(`${REMOTE_CARD}//img`).first().waitFor();
    await page.waitForTimeout(600);
    // QR несёт токен — размываем до нечитаемого прямо в странице, до снимка.
    await page.evaluate(() => {
      for (const img of document.querySelectorAll('img[src^="data:image"]')) {
        img.style.filter = 'blur(7px)';
      }
    });
    await bringIntoView(page, REMOTE_CARD, 28);
    await assertNoLeak(page, secrets);
    await scenario.shot(page, '03-pairing-code', {
      clip: REMOTE_CARD,
      padding: 20,
      maskText: [...MASKS, token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')],
    });
  } finally {
    await page.close();
    // Следующий вариант начинается с выключенной карточки.
    await patchRemote({ enabled: false }, token);
  }
}

for (const port of [PANEL_PORT, WEB_PORT]) {
  if (await portBusy(port)) {
    console.error(`порт ${port} занят — задайте GUIDE_PANEL_PORT / GUIDE_WEB_PORT`);
    process.exit(2);
  }
}

const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'cc-phone-shots-')));
const home = join(root, 'home');
const cfg = join(home, '.claude');
const bin = join(root, 'bin');
for (const dir of [cfg, bin, join(home, 'AppData/Roaming'), join(home, 'AppData/Local')]) {
  mkdirSync(dir, { recursive: true });
}
writeFileSync(join(cfg, 'settings.json'), '{}\n', 'utf8');

const system = IS_WIN
  ? [
      join(process.env.SystemRoot ?? 'C:\\Windows', 'System32'),
      process.env.SystemRoot ?? 'C:\\Windows',
    ]
  : ['/usr/bin', '/bin'];
const homeEnv = {
  HOME: home,
  USERPROFILE: home,
  CLAUDE_CONFIG_DIR: cfg,
  APPDATA: join(home, 'AppData/Roaming'),
  LOCALAPPDATA: join(home, 'AppData/Local'),
};
const base = Object.fromEntries(
  Object.entries(process.env).filter(
    ([key]) => !['PATH', ...Object.keys(homeEnv)].includes(key.toUpperCase()),
  ),
);
const started = [];
let exitCode = 0;
try {
  started.push(
    spawn(process.execPath, ['--experimental-strip-types', '--no-warnings', 'src/index.ts'], {
      cwd: join(REPO_ROOT, 'apps/server'),
      env: {
        ...base,
        ...homeEnv,
        PATH: [bin, ...system].join(IS_WIN ? ';' : ':'),
        PORT: String(PANEL_PORT),
        WEB_PORT: String(WEB_PORT),
      },
      stdio: 'ignore',
      shell: false,
    }),
  );
  if (!(await waitFor(`${PANEL}/api/system`, 40)))
    throw new Error('одноразовая панель не поднялась');
  // Токен панель заводит сама при первом чтении — берём его её же ручкой.
  const { token, detectedUrl } = await (await fetch(`${PANEL}/api/remote`)).json();
  // Настоящее имя машины в tailnet (если Tailscale есть) — то, что в кадр не должно попасть.
  // Имя машины и пользователя — всегда: без Tailscale список иначе пуст и страж молчит.
  const secrets = [hostname(), userInfo().username].filter((needle) => needle.length >= 4);
  if (detectedUrl) {
    const host = new URL(detectedUrl).hostname;
    secrets.push(host, host.split('.')[0]);
  }
  if (!token) throw new Error('одноразовая панель не отдала токен');
  started.push(
    spawn(
      process.execPath,
      [
        join('node_modules', 'vite', 'bin', 'vite.js'),
        '--port',
        String(WEB_PORT),
        '--strictPort',
        '--host',
        '127.0.0.1',
      ],
      {
        cwd: join(REPO_ROOT, 'apps/web'),
        env: {
          ...base,
          ...homeEnv,
          PATH: process.env.PATH ?? process.env.Path,
          API_PORT: String(PANEL_PORT),
          BROWSER: 'none',
        },
        stdio: 'ignore',
        shell: false,
      },
    ),
  );
  if (!(await waitFor(WEB, 120))) throw new Error('фронт одноразовой панели не поднялся');
  await patchSettings(PANEL, { onboardingDone: true });

  const browser = await chromium.launch();
  try {
    for (const theme of SHOT_THEMES) {
      for (const lang of SHOT_LANGS) {
        await applyShotLanguage(PANEL, lang, theme);
        const scenario = openScenario('phone', 'pair', lang, theme);
        console.log(`\nсценарий phone/pair [${theme}-${lang}]`);
        await shoot(browser, scenario, token, secrets);
        scenario.finish();
      }
    }
  } finally {
    await browser.close();
  }
  writeVariantIndex('phone');
} catch (error) {
  console.error(error instanceof Error ? (error.stack ?? error.message) : error);
  exitCode = 1;
} finally {
  for (const child of started) stopChild(child);
  await wait(600);
  rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
}
process.exit(exitCode);
