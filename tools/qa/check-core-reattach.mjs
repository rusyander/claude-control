/**
 * Ядро — одно целое с панелью (этап 10, приёмка «ядро стартует вместе с приложением»): ядро
 * одноразовой панели поднимает НАДЗОР панели, как у человека; ядро убито посреди чата — надзор
 * поднимает новое с отсрочкой, а задача продолжает тот же сеанс (хост сеансов пережил ядро, новое
 * ядро к нему переподключилось), без второго `session.started`.
 *
 * Дорога настоящая: браузер → Vite → панель → прокладка → ядро → хост сеансов → настоящий `claude`
 * из PATH. Подменены только внешние границы: модель — сценарий `chatScript` над
 * `packages/stub-model` (маршрут `stub:stand`), дома временные.
 *
 * Что проверяется:
 * 1. Ядра стенд не запускал — надзор панели поднял его (`/api/core/supervisor` up, pid).
 * 2. Чат ядра: первый ход получил ответ.
 * 3. Ядро убито — надзор поднял новое (другой pid, `restarts` ≥ 1, отсрочка названа).
 * 4. Второй ход, отправленный сразу, как новое ядро поднялось, получил ответ быстрее окна молчания
 *    аренды (STALE_MS): аренда мёртвого держателя этой машины перехвачена сразу; на экране нет сырых
 *    409/503, ответы ядра на команды после падения — не отказы.
 * 5. В журнале задачи ровно один `session.started`, хост сеансов тот же и жив — задача
 *    переподключилась, а не началась заново.
 *
 * Красный прогон: `SUPERVISED=0 node tools/qa/check-core-reattach.mjs` — ядро запускает сам стенд,
 * надзор выключен (как до этапа 10): убитое ядро никто не поднимает, строки 3–6 краснеют. До
 * перехвата аренды у доказанно мёртвого держателя (03.11) краснели строки 4–6: 409 «held», пока
 * не пройдут 15 с молчания.
 *
 * Запуск: `node tools/qa/check-core-reattach.mjs` (стенд свой, `pnpm dev` не нужен; нужен `claude`
 * в PATH). Код выхода: 0 — сходится, 1 — провал, 2 — стенд не поднялся / `claude` нет.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { FILE_MARK } from './check-core-chat.mjs';
import { uuidv7 } from './core-scenario-stand.mjs';
import { NotChecked, runOnStand, wait } from './throwaway-stand.mjs';

const { BEAT_MS, STALE_MS } = await import('../../apps/core/src/journal/lease.ts');

const CHAT_SCRIPT = resolve(dirname(fileURLToPath(import.meta.url)), 'check-core-chat.mjs');
const supervised = process.env.SUPERVISED !== '0';

const claudeAt = (() => {
  const r = spawnSync(process.platform === 'win32' ? 'where' : 'which', ['claude'], {
    encoding: 'utf8',
  });
  return r.status === 0 ? r.stdout.split(/\r?\n/)[0].trim() : '';
})();

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const git = (cwd, args) => {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (r.status) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
};

let repo = '';

await runOnStand(
  {
    label: 'core-reattach',
    // Каталог claude — в конец PATH: стенд вырезает его из PATH оболочки, сеанс ядра зовёт его.
    extraPath: claudeAt ? [dirname(claudeAt)] : [],
    core: {
      supervised,
      stub: [
        {
          name: 'stand',
          script: { module: CHAT_SCRIPT, export: 'chatScript', args: [{ file: '__FILE__' }] },
        },
      ],
    },
    seed: ({ root, coreHome }) => {
      repo = join(root, 'repo');
      const file = join(repo, 'notes.txt');
      mkdirSync(repo, { recursive: true });
      git(repo, ['init', '-q', '-b', 'main']);
      git(repo, ['config', 'user.name', 'stand']);
      git(repo, ['config', 'user.email', 'stand@example.invalid']);
      writeFileSync(file, `${FILE_MARK}\n`);
      git(repo, ['add', '.']);
      git(repo, ['commit', '-qm', 'init']);
      const cfgPath = join(coreHome, 'config.json');
      const cfg = JSON.parse(readFileSync(cfgPath, 'utf8'));
      cfg.routes.stub[0].script.args[0].file = file;
      writeFileSync(cfgPath, `${JSON.stringify(cfg, null, 2)}\n`);
    },
  },
  async (stand, check) => {
    if (!claudeAt) throw new NotChecked('claude не найден в PATH — сеанс ядра не запустить');
    const status = () =>
      stand
        .api('/core/supervisor')
        .then((r) => r.body)
        .catch(() => null);
    async function until(test, ms = 60_000) {
      const end = Date.now() + ms;
      for (;;) {
        const got = await status();
        if (test(got)) return got;
        if (Date.now() > end) return got;
        await wait(300);
      }
    }
    const journal = (taskId) => {
      const dir = join(stand.coreHome, 'tasks', taskId);
      const name = readdirSync(dir).find((f) => f.endsWith('.jsonl'));
      return readFileSync(join(dir, name), 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l));
    };

    // 1. Ядро стенда — от надзора (или от стенда в красном прогоне).
    const first = supervised ? await until((s) => s?.state === 'up') : null;
    const corePid = supervised ? first?.pid : stand.corePid();
    check(
      supervised
        ? `ядро поднял надзор панели (up, pid ${first?.pid})`
        : `ядро запустил стенд, надзор выключен (pid ${corePid})`,
      Number.isInteger(corePid),
      JSON.stringify(first),
    );

    // Маршрут задачи — заглушка: засев прямо в ядро (ключ ядра + число страницы), как в чате ядра.
    const token = readFileSync(join(stand.coreHome, 'token'), 'utf8').trim();
    const coreUrl = () =>
      JSON.parse(readFileSync(join(stand.coreHome, 'procs.json'), 'utf8')).cores.at(-1).url;
    const direct = async (method, path, body) => {
      const res = await fetch(`${coreUrl()}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          ...(body ? { 'content-type': 'application/json' } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      return { status: res.status, text: await res.text() };
    };
    const seedCommand = async (taskId, kind, fields) => {
      const page = uuidv7();
      const minted = JSON.parse((await direct('GET', `/v1/nonce?page=${page}`)).text);
      return direct('POST', '/v1/commands', {
        cmdId: uuidv7(),
        kind,
        target: { taskId },
        fields,
        proof: { nonce: minted.nonce, page },
      });
    };

    const browser = await chromium.launch();
    try {
      const page = await stand.newPage(browser, { width: 1440, height: 1100 });
      const seeded = [];
      await page.route(/\/api\/core\/commands$/, async (route) => {
        const body = route.request().postDataJSON();
        if (body?.kind === 'set-cli') {
          const taskId = body.target.taskId;
          const r = await seedCommand(taskId, 'set-route', {
            scope: 'task',
            scopeId: taskId,
            allowedRoutes: [
              { adapter: 'claude', route: { kind: 'stub', id: 'stub:stand' }, modelPattern: '*' },
            ],
          });
          const m = await seedCommand(taskId, 'set-model', {
            scope: 'task',
            scopeId: taskId,
            model: 'stub-model',
            effort: null,
            timing: 'now',
          });
          seeded.push(`${r.status}/${m.status}`);
        }
        await route.continue();
      });

      // 2. Чат ядра, первый ход.
      await page.goto(`${stand.webUrl}/core/chat?project=${encodeURIComponent(repo)}`);
      await page.locator('[data-core-chat-start]').waitFor({ timeout: 120_000 });
      await page.locator('[data-core-chat-cli] select').selectOption('claude');
      await page.locator('[data-core-chat-first] textarea').fill('ход-1: привет, ядро');
      await page.locator('[data-core-chat-submit]').click();
      await page.waitForURL(/[?&]id=/, { timeout: 60_000 });
      const taskId = new URL(page.url()).searchParams.get('id');
      const answered = async (text, seconds = 180) =>
        page
          .locator('[data-core-chat-assistant]')
          .filter({ hasText: text })
          .first()
          .waitFor({ timeout: seconds * 1000 })
          .then(() => true)
          .catch(() => false);
      check(
        `первый ход получил ответ (задача ${taskId}, засев ${seeded.join(',')})`,
        await answered('ответ на ход-1'),
      );
      const startedBefore = journal(taskId).filter((l) => l.kind === 'session.started');
      const host = startedBefore[0]?.data?.hostPid;

      // 3. Ядро убито посреди чата. Ответы прокладки на команды экрана с этого места — в разбор.
      const answers = [];
      page.on('response', async (res) => {
        if (!/\/api\/core\/(commands|tasks)/.test(res.url()) || res.request().method() !== 'POST')
          return;
        answers.push(`${res.status()} ${(await res.text().catch(() => '')).slice(0, 200)}`);
      });
      const killedAt = Date.now();
      // Падение — смерть ОДНОГО процесса ядра (на Windows `TerminateProcess`): его отвязанные
      // хост сеансов и сервер заглушки живут дальше, как при настоящем сбое. Снятие деревом унесло
      // бы и сервер модели, к которому обращается живой CLI, — это уже не падение ядра.
      process.kill(corePid, 'SIGKILL');
      for (let i = 0; i < 20 && alive(corePid); i += 1) await wait(250);
      const second = await until(
        (s) => s?.state === 'up' && Number.isInteger(s.pid) && s.pid !== corePid,
        90_000,
      );
      check(
        `ядро убито — надзор поднял новое (${corePid} → ${second?.pid}, падений ${second?.restarts})`,
        second?.state === 'up' && second.pid !== corePid && second.restarts >= 1,
        JSON.stringify(second),
      );

      // 4. Тот же чат продолжается тем же сеансом. Держатель аренды на этой машине доказанно мёртв
      // (pid исчез) — новое ядро берёт аренду сразу (`journal/lease.ts`, 01 §Lease), без окна
      // молчания STALE_MS: ход уходит, как только новое ядро поднялось, — как отправил бы человек.
      // `WAIT_LEASE=1` — прежнее поведение проверки: ждать окно молчания перед ходом.
      let sentAt = 0;
      if (second?.state === 'up') {
        if (process.env.WAIT_LEASE === '1')
          await wait(Math.max(0, killedAt + STALE_MS + BEAT_MS - Date.now()));
        await page.locator('[data-core-chat-composer] textarea').waitFor({ timeout: 90_000 });
        await page.locator('[data-core-chat-composer] textarea').fill('ход-2: после падения ядра');
        sentAt = Date.now();
        await page.locator('[data-core-chat-send]').click();
      }
      const secondAnswered = await answered('ответ на ход-2', 120);
      const answeredIn = Date.now() - sentAt;
      // Причина провала — хвост журнала задачи и ответы ядра на команды экрана после падения.
      const why = secondAnswered
        ? ''
        : `журнал: ${journal(taskId)
            .slice(-8)
            .map((l) => `${l.kind}${l.data?.reason ? `(${l.data.reason})` : ''}`)
            .join(', ')}\n    команды: ${answers.join(' | ')}\n    экран: ${(
            await page
              .locator('[data-core-chat-screen]')
              .innerText()
              .catch(() => '')
          ).slice(-600)}`;
      check('второй ход того же чата получил ответ', secondAnswered, why);
      check(
        `ответ на второй ход — без окна молчания аренды (${answeredIn} мс < ${STALE_MS} мс от отправки)`,
        secondAnswered && answeredIn < STALE_MS,
        `ход отправлен через ${sentAt - killedAt} мс после падения`,
      );
      // Сырые отказы на экране: 409 «held» от аренды и 503 «ядро не отдало поток» в окне молчания.
      const screen = await page
        .locator('[data-core-chat-screen]')
        .innerText()
        .catch(() => '');
      const raw = /status code \d{3}|код 50\d|\b409\b/.exec(screen)?.[0] ?? '';
      const refused = answers.filter((a) => /^(409|50\d) /.test(a));
      check(
        'ни сырого 409/503 на экране, ни отказа ядра на команды после падения',
        !raw && refused.length === 0,
        `экран: «${raw}»; ответы: ${refused.join(' | ')}`,
      );
      const started = journal(taskId).filter((l) => l.kind === 'session.started');
      check(
        `сеанс тот же: session.started ${startedBefore.length} → ${started.length}, хост ${host} жив`,
        startedBefore.length === 1 && started.length === 1 && alive(host),
        JSON.stringify(started.map((l) => l.data?.hostPid)),
      );
      await page.close();
    } finally {
      await browser.close();
    }
  },
);
