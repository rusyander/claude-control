/**
 * Замер базы ядра не оставляет чата в списке человека (этап 11, волна 3). Настоящая дорога:
 * одноразовая панель, своё ядро, настоящие CLI из PATH человека за одноразовым контуром
 * (`stub-platform.mjs` за шлюзом ядра стенда) — подменена только модель.
 *
 * Ход чата идёт маршрутом с адресом (контур), поэтому ядро в фоне запускает пробу базы — второй
 * сеанс того же CLI на своей заглушке, где первое слово — метка «AGENTDECK_BASE_PROBE <id>».
 * Проверяется для каждого CLI из `--cli=` (по умолчанию claude,qwen):
 *   - проба шла: каталог `…/sessions/<сеанс>/base-probe` есть, в журнале задачи — `context.base`
 *     (без этого «строки нет» значило бы «пробы не было»);
 *   - ни один файл дома стенда (хранилища транскриптов CLI: `.claude/projects`, `.qwen/projects`…)
 *     не несёт метку;
 *   - в `/api/chats` и `/api/chats/projects` (список компьютера и телефона) строки с меткой нет.
 *
 * Запуск: `node tools/qa/check-core-base-probe.mjs [--cli=claude,qwen]`.
 * `SHOTS=<dir>` — кадр списка чатов в обеих темах, `SHOT_TAG=BEFORE|AFTER` — суффикс кадра.
 * Код выхода: 0 — сходится, 1 — провал, 2 — не проверено.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';

const MARK = 'AGENTDECK_BASE_PROBE';
const arg = (name) => {
  const hit = process.argv.slice(2).find((a) => a.startsWith(`--${name}=`));
  return hit === undefined ? undefined : hit.slice(name.length + 3);
};
const CLIS = (arg('cli') ?? 'claude,qwen')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
const SHOTS = process.env.SHOTS || '';
const SHOT_TAG = process.env.SHOT_TAG || 'AFTER';

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
const found = Object.fromEntries(CLIS.map((cli) => [cli, cliAt(cli)]));
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

const claudeStub = await startStubModel({ script: () => 'ответ заглушки claude' });
const stubEnv = { ANTHROPIC_BASE_URL: claudeStub.baseUrl, ANTHROPIC_API_KEY: 'stand-stub-key' };
const contour = await startStubPlatform({ port: 0 });
const gatewayPort = await freePort();
let repo = '';

/** Файлы под `root` с меткой пробы; каталог `skip` (дом ядра — свои журналы пробы) не читается. */
function marked(root, skip = '') {
  const out = [];
  const walk = (dir) => {
    if (skip && dir === skip) return;
    let names;
    try {
      names = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of names) {
      const path = join(dir, name);
      let st;
      try {
        st = statSync(path);
      } catch {
        continue;
      }
      if (st.isDirectory()) walk(path);
      else if (st.size <= 8 * 1024 * 1024 && readFileSync(path).includes(MARK)) out.push(path);
    }
  };
  walk(root);
  return out;
}

const tasksOf = (stand) => {
  try {
    return readdirSync(join(stand.coreHome, 'tasks'));
  } catch {
    return [];
  }
};
function journalOf(stand, taskId) {
  const dir = join(stand.coreHome, 'tasks', taskId);
  const name = readdirSync(dir).find((f) => f.endsWith('.jsonl'));
  if (!name) return [];
  return readFileSync(join(dir, name), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}
/** Каталоги пробы базы задачи: `tasks/<задача>/sessions/<сеанс>/base-probe`. */
function probeDirs(stand, taskId) {
  const sessions = join(stand.coreHome, 'tasks', taskId, 'sessions');
  if (!existsSync(sessions)) return [];
  return readdirSync(sessions)
    .map((s) => join(sessions, s, 'base-probe'))
    .filter((d) => existsSync(d));
}

async function patchSettings(page, change) {
  await page.waitForLoadState('load');
  const status = await page.evaluate(async (body) => {
    const res = await fetch('/api/settings', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    return res.status;
  }, change);
  if (status !== 200) throw new Error(`настройки ${JSON.stringify(change)}: ${status}`);
}

/** Строки списков компьютера и телефона, где есть метка пробы. */
function probeRows(page) {
  return page.evaluate(async (mark) => {
    const chats = await (await fetch('/api/chats')).json();
    const projects = await (await fetch('/api/chats/projects')).json();
    const flat = projects.flatMap((p) => p.chats.map((c) => ({ ...c, path: p.path })));
    const hit = (c) => JSON.stringify(c).includes(mark);
    return {
      desktop: chats.filter(hit).map((c) => c.title),
      phone: flat.filter(hit).map((c) => c.title),
      total: { desktop: chats.length, phone: flat.length },
    };
  }, MARK);
}

async function activateContour(stand, check) {
  const CONTOUR = 'probe-chat';
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
        // Чужой CLI идёт через контур по своей галочке (`chatConsumerOf`), «Чат» — только Claude.
        consumers: [
          'chat',
          ...CLIS.filter((cli) => cli !== 'claude').map((cli) => `foreign:${cli}`),
        ],
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
    'контур стенда «Чат» сохранён, активен, шлюз на своём порту',
    saved.status === 200 &&
      activated.body?.activePlatformId === CONTOUR &&
      restarted.body?.status?.running === true,
    JSON.stringify([saved.body, activated.body, restarted.body?.status]).slice(0, 500),
  );
}

/** Ход чата CLI маршрутом контура; ждёт пробу базы его задачи. */
async function turnWithProbe(stand, check, browser, cli) {
  const page = await openProjectChat(stand, browser, repo, 'repo');
  try {
    await patchSettings(page, { provider: cli });
    await page.reload();
    await dismissAccess(page);
    await page.getByRole('button', { name: 'Новый чат', exact: true }).first().click();
    await wait(1000);
    const before = tasksOf(stand);
    const input = page.locator('textarea[data-chat-input]');
    await input.waitFor({ timeout: 60_000 });
    await input.fill(`замер-1: ${cli} привет`);
    await input.press('Enter');
    let task = '';
    let probes = [];
    let measured = false;
    for (let i = 0; i < 180 && !measured; i++) {
      await wait(1000);
      task ||= tasksOf(stand).find((t) => !before.includes(t)) ?? '';
      if (!task) continue;
      probes = probeDirs(stand, task);
      measured = journalOf(stand, task).some((l) => l.kind === 'context.base');
    }
    const stop = page.getByRole('button', { name: 'Остановить' });
    for (let i = 0; i < 120 && (await stop.count()) > 0; i++) await wait(500);
    // Проба снимается остановкой своего CLI — запись хранилища (если была) к этому мигу на диске.
    await wait(3000);
    check(
      `${cli}: ход ушёл маршрутом контура, проба базы шла (задача ${task || 'нет'}, каталогов пробы ${probes.length}, context.base ${measured})`,
      Boolean(task) && probes.length >= 1 && measured,
    );
    const left = marked(stand.home, stand.coreHome).map((p) => relative(stand.home, p));
    check(
      `${cli}: ни один файл дома стенда не несёт метку пробы (${left.join(', ') || 'нет'})`,
      left.length === 0,
    );
    await page.reload();
    await dismissAccess(page);
    await wait(2000);
    const rows = await probeRows(page);
    check(
      `${cli}: в /api/chats и /api/chats/projects строки пробы нет (компьютер ${rows.desktop.join(' · ') || 'нет'} из ${rows.total.desktop}; телефон ${rows.phone.join(' · ') || 'нет'} из ${rows.total.phone})`,
      rows.desktop.length === 0 && rows.phone.length === 0 && rows.total.desktop >= 1,
    );
    const sidebar = await page
      .getByText(MARK)
      .count()
      .catch(() => -1);
    check(`${cli}: в боковом списке чатов строки пробы нет (${sidebar})`, sidebar === 0);
    if (SHOTS) {
      mkdirSync(SHOTS, { recursive: true });
      for (const theme of ['light', 'dark']) {
        await page.evaluate((t) => {
          document.documentElement.dataset.theme = t;
          document.documentElement.style.colorScheme = t;
        }, theme);
        await page.waitForTimeout(250);
        await page.screenshot({
          path: join(SHOTS, `probe-list-${cli}-${theme}_${SHOT_TAG}.png`),
        });
      }
    }
  } finally {
    await page.close();
  }
}

await runOnStand(
  {
    label: 'core-base-probe',
    extraPath,
    env: stubEnv,
    core: true,
    settings: { platformGateway: { enabled: true, port: gatewayPort, forceStream: true } },
    seed: ({ root }) => {
      repo = join(root, 'repo');
      mkdirSync(repo, { recursive: true });
      git(repo, ['init', '-q', '-b', 'main']);
      git(repo, ['config', 'user.name', 'stand']);
      git(repo, ['config', 'user.email', 'stand@example.invalid']);
      writeFileSync(join(repo, 'notes.txt'), 'заметки\n');
      git(repo, ['add', '.']);
      git(repo, ['commit', '-qm', 'init']);
    },
  },
  async (stand, check) => {
    const browser = await chromium.launch();
    try {
      const present = CLIS.filter((cli) => found[cli]);
      if (present.length === 0) throw new NotChecked(`нет в PATH: ${CLIS.join(', ')}`);
      for (const cli of CLIS.filter((c) => !found[c])) console.log(`  ~ ${cli} нет в PATH`);
      await activateContour(stand, check);
      for (const cli of present) {
        await turnWithProbe(stand, check, browser, cli).catch((error) =>
          check(`${cli}: сценарий дошёл до конца`, false, error?.stack ?? String(error)),
        );
      }
    } finally {
      await browser.close();
      await claudeStub.close();
      await contour.close();
    }
  },
);
