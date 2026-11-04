/**
 * Общая обвязка проверок сценариев ядра (`check-core-scenario*.mjs`): стенд с ядром, репозиторий
 * git под оценку, засев прямо в ядро и кадры в обеих темах. Засев идёт с токеном ядра из этого
 * процесса — пир «чистый» (не потомок сессии модели): это подготовка данных, а не проверяемая
 * дорога; проверяемая — браузер через прокладку панели.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const SHOTS = process.env.SHOTS || '';

// Ядру нужен найденный CLI, чтобы дорога `cli` предпроверки прошла; сама модель стенду не нужна.
const FAKE_CLAUDE = `process.stderr.write('stand: no model here\\n'); process.exit(1);\n`;

/** UUIDv7 для `cmdId` и страницы числа: время в старших битах, версия 7, вариант 10xx. */
export function uuidv7() {
  const time = Date.now().toString(16).padStart(12, '0');
  const rand = [...crypto.getRandomValues(new Uint8Array(10))]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  const variant = ((parseInt(rand[3], 16) & 0x3) | 0x8).toString(16);
  return `${time.slice(0, 8)}-${time.slice(8)}-7${rand.slice(0, 3)}-${variant}${rand.slice(4, 7)}-${rand.slice(7, 19)}`;
}

const step = (id, kind, title, after) => ({
  id,
  kind,
  title,
  after,
  knowledge: { skills: [], rules: [], hooks: [], scripts: [] },
  model: { tier: 'ceiling' },
  checks: { mid: 'narrow', required: [] },
  roundCap: 2,
  budget: {},
  overBudget: 'ask',
  userLayer: { hooks: 'on', skills: 'on' },
  gate: [],
});

/** Своя версия человека для библиотеки: два шага цепочкой. */
export const QA_FLOW = {
  id: 'qa-flow',
  version: 1,
  title: 'Проверочный поток',
  steps: [step('plan', 'plan', 'План', []), step('work', 'work', 'Работа', ['plan'])],
};

/**
 * Опции стенда: ядро, подставной CLI и репозиторий git. Грант не подтверждён — задача после
 * оценки ждёт человека и остаётся живой (06:108). Путь репозитория — в `holder.repo`.
 */
export function standOptions(label, holder) {
  return {
    label,
    core: true,
    fakeCli: { claude: FAKE_CLAUDE },
    seed: async ({ root, coreHome }) => {
      const repo = join(root, 'repo');
      holder.repo = repo;
      const cfgPath = join(coreHome, 'config.json');
      const cfg = JSON.parse(readFileSync(cfgPath, 'utf8'));
      cfg.grantRequired = [{ project: repo, globs: ['**'], ops: ['edit'] }];
      writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
      mkdirSync(repo, { recursive: true });
      const git = (...a) => execFileSync('git', a, { cwd: repo, encoding: 'utf8' });
      git('init', '-q', '-b', 'main');
      git('config', 'user.email', 'stand@example.com');
      git('config', 'user.name', 'stand');
      writeFileSync(join(repo, 'a.txt'), 'a\n');
      git('add', '.');
      git('commit', '-qm', 'init');
    },
  };
}

/** Засев прямо в ядро стенда и чтение его библиотеки с диска. */
export function coreDirect(stand) {
  // `claude.cmd` формы npm cmd-shim (её одну ядро разбирает на Windows) пишет сам стенд.
  const library = join(stand.coreHome, 'scenarios');
  const token = readFileSync(join(stand.coreHome, 'token'), 'utf8').trim();
  const core = JSON.parse(readFileSync(join(stand.coreHome, 'procs.json'), 'utf8')).cores.at(-1);
  const direct = async (method, path, body) => {
    const res = await fetch(`${core.url}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : undefined, text };
  };
  const proof = async () => {
    const page = uuidv7();
    const minted = await direct('GET', `/v1/nonce?page=${page}`);
    return { nonce: minted.body?.nonce, page };
  };
  return {
    library,
    files: () => (existsSync(library) ? readdirSync(library).sort() : []),
    read: (name) => JSON.parse(readFileSync(join(library, name), 'utf8')),
    direct,
    proof,
    save: async (scenario) =>
      direct('POST', '/v1/scenarios', { cmdId: uuidv7(), scenario, proof: await proof() }),
  };
}

/**
 * `CORE_DIRECT=1` — обход ОДНОГО шва, как в check-core-launch: строгие записи браузера (запись
 * сценария, команды) идут прямо в ядро стенда с его токеном, мимо опознания пира прокладкой.
 * Ответы — живого ядра, ничего не подделано; режим показывает дорогу успеха, пока звено панели
 * не подтверждено ядру (P131). Вердикт кейса — только прогон без флага.
 */
export const DIRECT = process.env.CORE_DIRECT === '1';

export async function routeStrictToCore(page, stand) {
  if (!DIRECT) return;
  const token = readFileSync(join(stand.coreHome, 'token'), 'utf8').trim();
  const core = JSON.parse(readFileSync(join(stand.coreHome, 'procs.json'), 'utf8')).cores.at(-1);
  await page.route(/\/api\/core\/(scenarios|commands)$/, async (route) => {
    if (route.request().method() !== 'POST') return route.continue();
    const tail = new URL(route.request().url()).pathname.replace(/^\/api\/core/, '/v1');
    const response = await route.fetch({
      url: `${core.url}${tail}`,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    });
    await route.fulfill({ response });
  });
}

/** Кадр страницы в светлой и тёмной теме (`SHOTS=<папка>`); без папки — ничего. */
export async function shoot(page, name) {
  if (!SHOTS) return;
  mkdirSync(SHOTS, { recursive: true });
  for (const theme of ['light', 'dark']) {
    await page.evaluate((t) => {
      document.documentElement.dataset.theme = t;
      document.documentElement.style.colorScheme = t;
    }, theme);
    await page.waitForTimeout(150);
    await page.screenshot({ path: join(SHOTS, `${name}-${theme}_AFTER.png`), fullPage: true });
  }
  await page.evaluate(() => {
    document.documentElement.dataset.theme = 'light';
  });
}
