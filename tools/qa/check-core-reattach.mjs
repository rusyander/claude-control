/**
 * Ядро — одно целое с панелью (этап 10, приёмка «ядро стартует вместе с приложением»): ядро
 * одноразовой панели поднимает НАДЗОР панели, как у человека; ядро убито посреди чата — надзор
 * поднимает новое с отсрочкой, а задача продолжает тот же сеанс (хост сеансов пережил ядро, новое
 * ядро к нему переподключилось), без второго `session.started`.
 *
 * Дорога настоящая: браузер → Vite → панель → прокладка → ядро → хост сеансов → настоящий `claude`
 * из PATH. Подменены только внешние границы: модель — сценарий `chatScript` над
 * `packages/stub-model` по адресу из `env` личного settings.json стенда (маршрут задачи без контура —
 * вход CLI), дома временные.
 *
 * Что проверяется:
 * 1. Ядра стенд не запускал — надзор панели поднял его (`/api/core/supervisor` up, pid).
 * 2. Новый чат в едином чате `/chat` (этап 11): первый ход — задача ядра, получил ответ.
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
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { chromium } from 'playwright';
import { startStubModel } from '../../packages/stub-model/src/index.mjs';
import { FILE_MARK, chatScript } from './check-core-chat.mjs';
import { openProjectChat } from './chat-walk.mjs';
import { NotChecked, runOnStand, wait } from './throwaway-stand.mjs';

const { BEAT_MS, STALE_MS } = await import('../../apps/core/src/journal/lease.ts');

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
let file = 'notes.txt';
// Модель — заглушка в этом процессе: падение ядра её не задевает, как настоящего вендора.
const model = await startStubModel({ script: (ctx) => chatScript({ file })(ctx) });
const stubEnv = { ANTHROPIC_BASE_URL: model.baseUrl, ANTHROPIC_API_KEY: 'stand-stub-key' };

await runOnStand(
  {
    label: 'core-reattach',
    // Каталог claude — в конец PATH: стенд вырезает его из PATH оболочки, сеанс ядра зовёт его.
    extraPath: claudeAt ? [dirname(claudeAt)] : [],
    env: stubEnv,
    core: { supervised },
    seed: ({ root }) => {
      repo = join(root, 'repo');
      file = join(repo, 'notes.txt');
      mkdirSync(repo, { recursive: true });
      git(repo, ['init', '-q', '-b', 'main']);
      git(repo, ['config', 'user.name', 'stand']);
      git(repo, ['config', 'user.email', 'stand@example.invalid']);
      writeFileSync(file, `${FILE_MARK}\n`);
      git(repo, ['add', '.']);
      git(repo, ['commit', '-qm', 'init']);
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

    // Вход claude стенда — адрес заглушки в `env` личного settings.json: маршрут задачи без
    // контура — вход CLI, и ядро передаёт личный слой как есть.
    const settingsPath = join(stand.cfg, 'settings.json');
    const settings = existsSync(settingsPath) ? JSON.parse(readFileSync(settingsPath, 'utf8')) : {};
    writeFileSync(
      settingsPath,
      `${JSON.stringify({ ...settings, env: { ...settings.env, ...stubEnv } }, null, 2)}\n`,
    );
    const tasks = () => {
      try {
        return readdirSync(join(stand.coreHome, 'tasks'));
      } catch {
        return [];
      }
    };

    const browser = await chromium.launch();
    try {
      // 2. Новый чат в едином чате `/chat` (этап 11, W3-17a), первый ход — задача ядра.
      const page = await openProjectChat(stand, browser, repo, 'repo');
      await page.getByRole('button', { name: 'Новый чат', exact: true }).first().click();
      const input = page.locator('textarea[data-chat-input]');
      await input.waitFor({ timeout: 120_000 });
      const before = tasks();
      await input.fill('ход-1: привет, ядро');
      await input.press('Enter');
      let taskId;
      for (let i = 0; i < 90 && !taskId; i++) {
        taskId = tasks().find((t) => !before.includes(t));
        if (!taskId) await wait(1000);
      }
      if (!taskId)
        throw new Error(`ход /chat не завёл задачу ядра: ${stand.coreLog().slice(-1200)}`);
      const answered = async (text, seconds = 180) =>
        page
          .locator('[data-feed-message]')
          .filter({ hasText: text })
          .first()
          .waitFor({ timeout: seconds * 1000 })
          .then(() => true)
          .catch(() => false);
      check(`первый ход получил ответ (задача ${taskId})`, await answered('ответ на ход-1'));
      const startedBefore = journal(taskId).filter((l) => l.kind === 'session.started');
      const host = startedBefore[0]?.data?.hostPid;

      // 3. Ядро убито посреди чата. Ответы прокладки на команды экрана с этого места — в разбор.
      const answers = [];
      page.on('response', async (res) => {
        if (
          !/\/api\/(core\/(commands|tasks)|chat\/)/.test(res.url()) ||
          res.request().method() !== 'POST'
        )
          return;
        answers.push(`${res.status()} ${(await res.text().catch(() => '')).slice(0, 200)}`);
      });
      const killedAt = Date.now();
      // Падение — смерть ОДНОГО процесса ядра (на Windows `TerminateProcess`): его отвязанные
      // хосты сеансов живут дальше, как при настоящем сбое. Снятие деревом унесло бы и сеанс с
      // живым CLI — это уже не падение ядра.
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
        await input.waitFor({ timeout: 90_000 });
        await input.fill('ход-2: после падения ядра');
        sentAt = Date.now();
        await input.press('Enter');
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
              .locator('main')
              .first()
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
        .locator('main')
        .first()
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
      await model.close();
    }
  },
);
