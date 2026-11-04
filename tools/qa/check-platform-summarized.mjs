/**
 * «Контур сжал историю» — НА ПРОВОДЕ и НА ЭКРАНЕ.
 *
 * Контур сам сжимает длинную переписку и говорит об этом одним кадром потока
 * (`platform_status: summarizing`). Модульные тесты кормят разборщик кадром,
 * собранным тут же, и зеленеют даже тогда, когда до ленты чата не доходит
 * ничего. Здесь подменены только модель (стаб-контур) и, во второй части,
 * чужой CLI; всё остальное настоящее:
 *
 *   1. настоящий `claude.exe` ходит через шлюз одноразовой панели, пишет свой
 *      транскрипт, и подпись о сжатии стоит в ленте у ТОГО ответа, где контур
 *      прислал кадр, — у второго, а у первого нет (сопоставление по id
 *      сообщения, который шлюз выдал клиенту сам);
 *   2. раздел «Контур» показывает случай сжатия и говорит, к чему он привязан.
 *
 * Часть про чат чужого CLI (фальшивый `qwen` прежним исполнителем панели) снята на этапе 10
 * (F2c): чат чужого CLI — задача ядра, разговор панели не заводится (410 `provider-chat-core`).
 *
 * Снимки: `.agent/screenshots/before-after/summarizing-caption/<SHOT_PHASE>-*.png`.
 *
 * Запуск: `node tools/qa/check-platform-summarized.mjs` (стенд человека не
 * нужен и не трогается; порты SUM_PANEL_PORT/SUM_WEB_PORT/SUM_GATEWAY_PORT,
 * по умолчанию 5262/8972/5263). Нужен установленный `claude` (или CLAUDE_CLI).
 */
import { spawn } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { chromium } from 'playwright';
import { startStubPlatform } from './stub-platform.mjs';
import { bypassOnboarding } from './bypass-onboarding.mjs';
import { reapCoreSessions } from './throwaway-stand.mjs';

const REPO = resolve(import.meta.dirname, '../..');
const PANEL_PORT = Number(process.env.SUM_PANEL_PORT ?? 5262);
const WEB_PORT = Number(process.env.SUM_WEB_PORT ?? 8972);
const GATEWAY_PORT = Number(process.env.SUM_GATEWAY_PORT ?? 5263);
const PANEL = `http://127.0.0.1:${PANEL_PORT}`;
const WEB = `http://127.0.0.1:${WEB_PORT}`;
const CONTOUR = 'squeeze-company';
const PHASE = process.env.SHOT_PHASE ?? 'after';
const SHOTS = join(REPO, '.agent/screenshots/before-after/summarizing-caption');
/** Заглушки вместо ключей: собраны из кусков, чтобы не походить на секрет. */
const KEY = ['squeeze', 'stub', 'key'].join('-');
const ROUTE_TOKEN = ['panel', 'contour', 'no', 'key', 'needed'].join('-');

let failures = 0;
let panelLog = '';
const readJsonQuiet = (file) => {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return undefined;
  }
};
const check = (name, condition, detail = '') => {
  if (condition) console.log(`  ✓ ${name}`);
  else {
    failures += 1;
    console.log(`  ✗ ${name}${detail ? `\n    ${detail}` : ''}`);
  }
};
class NotChecked extends Error {}
const wait = (ms) => new Promise((done) => setTimeout(done, ms));

function resolveClaude() {
  if (process.env.CLAUDE_CLI) return process.env.CLAUDE_CLI;
  if (process.platform !== 'win32') return 'claude';
  const tail = join('node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe');
  for (const root of [dirname(process.execPath), join(process.env.APPDATA ?? '', 'npm')]) {
    if (existsSync(join(root, tail))) return join(root, tail);
  }
  return '';
}

async function waitFor(url, seconds) {
  for (let i = 0; i < seconds * 4; i += 1) {
    try {
      const res = await fetch(url);
      if (res.status < 500) return res;
    } catch {
      // ещё не поднялся
    }
    await wait(250);
  }
  return undefined;
}

async function api(path, init = {}) {
  const res = await fetch(`${PANEL}/api${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
  });
  const text = await res.text();
  try {
    return { status: res.status, body: text ? JSON.parse(text) : undefined };
  } catch {
    return { status: res.status, body: text };
  }
}

/** Один ход настоящего `claude -p` через шлюз; сессию продолжает `resume`. */
async function runClaude(exe, { home, work, model, prompt, resume }) {
  const args = ['-p', prompt, '--output-format', 'json', '--max-turns', '1'];
  if (resume) args.push('--resume', resume);
  const cli = spawn(exe, args, {
    cwd: work,
    env: {
      ...process.env,
      CLAUDE_CONFIG_DIR: home,
      ANTHROPIC_BASE_URL: `http://127.0.0.1:${GATEWAY_PORT}/${CONTOUR}`,
      ANTHROPIC_AUTH_TOKEN: ROUTE_TOKEN,
      ANTHROPIC_MODEL: model,
      ANTHROPIC_SMALL_FAST_MODEL: 'stub-chat',
      DISABLE_TELEMETRY: '1',
      DISABLE_AUTOUPDATER: '1',
      DISABLE_ERROR_REPORTING: '1',
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: false,
  });
  let out = '';
  cli.stdout.on('data', (chunk) => (out += chunk));
  cli.stderr.on('data', (chunk) => (out += chunk));
  const code = await new Promise((done) => {
    const timer = setTimeout(() => {
      cli.kill();
      done('таймаут');
    }, 120_000);
    cli.on('close', (value) => {
      clearTimeout(timer);
      done(value);
    });
  });
  let sessionId = '';
  try {
    sessionId = JSON.parse(out.trim().split('\n').at(-1) ?? '{}').session_id ?? '';
  } catch {
    // вывод не JSON — код выхода и хвост скажут почему
  }
  return { code, out, sessionId };
}

async function main() {
  const exe = resolveClaude();
  if (!exe) throw new NotChecked('не нашёлся настоящий `claude` — задайте путь через CLAUDE_CLI.');
  mkdirSync(SHOTS, { recursive: true });

  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'cc-squeeze-')));
  const home = join(root, 'home');
  const cfg = join(home, '.claude');
  const bin = join(root, 'bin');
  const work = join(root, 'work');
  for (const dir of [cfg, bin, work, join(home, 'AppData/Roaming'), join(home, 'AppData/Local')]) {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(join(cfg, 'settings.json'), '{}\n', 'utf8');
  writeFileSync(
    join(cfg, '.claude.json'),
    JSON.stringify({
      hasCompletedOnboarding: true,
      projects: { [work]: { hasTrustDialogAccepted: true, allowedTools: [] } },
    }),
    'utf8',
  );

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
  const pathSep = process.platform === 'win32' ? ';' : ':';
  const PATH = [bin, process.env.PATH ?? process.env.Path].join(pathSep);

  const stub = await startStubPlatform({ port: 0 });
  const children = [];
  const panel = spawn(
    process.execPath,
    ['--experimental-strip-types', '--no-warnings', 'src/index.ts'],
    {
      cwd: join(REPO, 'apps/server'),
      env: { ...base, ...homeEnv, PATH, PORT: String(PANEL_PORT), WEB_PORT: String(WEB_PORT) },
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: false,
    },
  );
  // Строки учёта контуров (`contours: …`) — в отчёт провала: учёт ведёт звено ядра (C3b), и
  // отказ записи иначе не виден нигде.
  panel.stdout.on('data', (chunk) => (panelLog += chunk));
  panel.stderr.on('data', (chunk) => (panelLog += chunk));
  children.push(panel);
  const web = spawn(
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
      cwd: join(REPO, 'apps/web'),
      env: { ...base, ...homeEnv, PATH, API_PORT: String(PANEL_PORT), BROWSER: 'none' },
      stdio: 'ignore',
      shell: false,
    },
  );
  children.push(web);

  try {
    if (!(await waitFor(`${PANEL}/api/system`, 40)))
      throw new NotChecked('одноразовая панель не поднялась.');
    if (!(await waitFor(WEB, 60))) throw new NotChecked('одноразовый фронт не поднялся.');
    console.log(
      `CLI: ${exe}\nСтаб-контур: ${stub.url}\nПанель: ${PANEL}  фронт: ${WEB}  фаза снимков: ${PHASE}\n`,
    );
    await run({ exe, stub, cfg, work });
  } finally {
    for (const child of children) child.kill();
    // Ядро панель поднимает сама (надзор) отвязанным — снятие панели его не уносит; хост звеньев
    // и хосты сессий ядро держит и после себя. Снимаются по записям дома ядра, не по имени.
    const coreHome = join(home, '.agentdeck', 'core');
    for (const core of readJsonQuiet(join(coreHome, 'procs.json'))?.cores ?? []) {
      try {
        if (Number.isInteger(core?.pid) && core.pid > 0) process.kill(core.pid);
      } catch {
        // уже вышло
      }
    }
    reapCoreSessions(coreHome);
    await stub.close();
    await wait(500);
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
  }

  if (failures > 0) {
    const lines = panelLog.split('\n').filter((line) => line.includes('contours:'));
    if (lines.length > 0) console.log(`\nУчёт контуров в журнале панели:\n${lines.join('\n')}`);
  }
  console.log(failures === 0 ? '\nВсё сходится.' : `\nПровалов: ${failures}`);
  process.exit(failures === 0 ? 0 : 1);
}

async function openContour(stub) {
  const saved = await api(`/platforms/${CONTOUR}`, {
    method: 'PUT',
    body: JSON.stringify({
      settings: {
        id: CONTOUR,
        title: 'Стаб со сжатием',
        driver: 'enterprise-platform',
        baseUrl: stub.url,
        enabled: true,
        mode: 'best-effort',
        budgetUsd: 0,
        budgetSince: '',
        capabilities: [],
        targets: [],
        consumers: ['chat'],
        defaultModel: 'stub-chat',
        projectPaths: [],
        agents: [],
        caCertPath: '',
        toolShim: false,
        contourPrompt: false,
      },
      token: KEY,
    }),
  });
  if (saved.status >= 400)
    throw new NotChecked(`контур не сохранился: ${JSON.stringify(saved.body)}`);
  await api(`/platforms/${CONTOUR}/activate`, { method: 'POST', body: '{}' });
  await api('/settings', {
    method: 'PATCH',
    body: JSON.stringify({
      platformGateway: { enabled: true, port: GATEWAY_PORT, forceStream: true },
    }),
  });
  const restarted = await api('/platforms/gateway/restart', { method: 'POST', body: '{}' });
  const port = restarted.body?.status?.port;
  if (port !== GATEWAY_PORT) throw new NotChecked(`шлюз встал не на ${GATEWAY_PORT}: ${port}`);
}

async function gatewayEvents() {
  return (await api('/platforms/gateway')).body?.status?.events ?? [];
}

async function run({ exe, stub, cfg, work }) {
  await openContour(stub);
  const browser = await chromium.launch();
  try {
    await claudePart({ exe, cfg, work, browser });
    await platformPart({ browser });
  } finally {
    await browser.close();
  }
}

async function newPage(browser, patch = {}) {
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  await bypassOnboarding(page, { language: 'ru', theme: 'light', ...patch });
  return page;
}

// ── 1. Чат Claude ──────────────────────────────────────────────────────────
async function claudePart({ exe, cfg, work, browser }) {
  console.log('Чат Claude: два хода настоящего CLI, сжатие только во втором…');
  const first = await runClaude(exe, {
    home: cfg,
    work,
    model: 'stub-chat',
    prompt: 'Первый вопрос: скажи привет',
  });
  check(
    'первый ход CLI прошёл через шлюз',
    first.code === 0 && first.sessionId,
    `код ${first.code}: ${first.out.slice(-400)}`,
  );
  if (!first.sessionId) return;
  const second = await runClaude(exe, {
    home: cfg,
    work,
    model: 'stub-summarizing',
    prompt: 'Второй вопрос: а теперь длинная история',
    resume: first.sessionId,
  });
  check(
    'второй ход CLI прошёл через шлюз',
    second.code === 0,
    `код ${second.code}: ${second.out.slice(-400)}`,
  );

  const events = (await gatewayEvents()).filter((event) => event.platformId === CONTOUR);
  const squeezed = events.filter((event) => event.summarized);
  check(
    'след шлюза записал сжатие и id сообщения, выданный клиенту',
    squeezed.length >= 1 &&
      squeezed.every((event) => typeof event.messageId === 'string' && event.messageId),
    JSON.stringify(
      events.map((event) => ({
        path: event.path,
        summarized: event.summarized,
        messageId: event.messageId,
      })),
    ),
  );

  const page1 = await api(`/chats/${first.sessionId}/messages?limit=50`);
  const assistants = (page1.body?.messages ?? []).filter(
    (message) =>
      message.role === 'assistant' && message.blocks.some((block) => block.type === 'text'),
  );
  check(
    'лента API: подпись только у второго ответа',
    assistants.length >= 2 &&
      assistants.at(-1).contextSummarized === true &&
      assistants.slice(0, -1).every((message) => !message.contextSummarized),
    JSON.stringify(
      assistants.map((message) => ({ id: message.id, summarized: message.contextSummarized })),
    ),
  );

  const page = await newPage(browser);
  await page.goto(`${WEB}/chat?id=${first.sessionId}`, { waitUntil: 'domcontentloaded' });
  await page
    .getByText('Второй вопрос')
    .first()
    .waitFor({ timeout: 30_000 })
    .catch(() => undefined);
  await wait(1500);
  const captions = page.locator('[data-context-summarized]');
  const count = await captions.count();
  const afterSecond =
    count === 1 &&
    (await page.evaluate(() => {
      const caption = document.querySelector('[data-context-summarized]');
      const prompts = [...document.querySelectorAll('*')].filter(
        (node) => node.childElementCount === 0 && node.textContent?.includes('Второй вопрос'),
      );
      const prompt = prompts[0];
      return Boolean(
        caption &&
        prompt &&
        prompt.compareDocumentPosition(caption) & Node.DOCUMENT_POSITION_FOLLOWING,
      );
    }));
  check(
    'экран чата Claude: одна подпись, и стоит она после второго вопроса',
    afterSecond,
    `подписей: ${count}`,
  );
  if (count > 0) await captions.first().scrollIntoViewIfNeeded();
  await page.screenshot({ path: join(SHOTS, `${PHASE}-chat-claude.png`) });
  await page.close();
}

// ── 2. Раздел «Контур» ─────────────────────────────────────────────────────
async function platformPart({ browser }) {
  const status = (await api('/platforms/gateway')).body?.status ?? {};
  const report = status.summarized;
  check(
    'сводка сжатий в состоянии шлюза: случай чата Claude привязан к сообщению',
    report?.total >= 1 && (report.recent ?? []).some((item) => item.link === 'message'),
    JSON.stringify(report),
  );
  const page = await newPage(browser, { provider: 'claude' });
  await page.goto(`${WEB}/platform?tab=tools`, { waitUntil: 'domcontentloaded' });
  const card = page.locator('[data-contour-summarized]');
  await card
    .first()
    .waitFor({ timeout: 20_000 })
    .catch(() => undefined);
  const rows = await page.locator('[data-contour-summarized-row]').count();
  check(
    'раздел «Контур»: карточка сжатий со строкой на каждый случай',
    rows >= 1,
    `строк: ${rows}`,
  );
  if (rows > 0) await card.first().scrollIntoViewIfNeeded();
  await page.screenshot({ path: join(SHOTS, `${PHASE}-platform.png`) });
  await page.close();
}

main().catch((error) => {
  if (error instanceof NotChecked) {
    console.log(`НЕ ПРОВЕРЕНО: ${error.message}`);
    process.exit(2);
  }
  console.error(error);
  process.exit(1);
});
