/**
 * Живая лента чата ядра: первый ход человека виден без перезагрузки и ровно один раз (зона C,
 * проход 8; находка съёмки контура «живьём 0, после перезагрузки 1»).
 *
 * Причина была в ядре: насос пишет отправку на своё смещение `stdout.log`, а оно отстаёт от файла.
 * Опрос вида, успевший раньше записи отправки, уводил курсор за это смещение — и ход человека в
 * живую ленту больше не попадал (`replaySession` отдавал отправку только при `at >= from`). Теперь
 * отправка несёт `seen` — длину вывода на миг записи — и встаёт в ленту не раньше неё.
 *
 * Дорога настоящая: браузер → Vite → панель → прокладка → ядро → хост сеансов → настоящий `claude`
 * из PATH. Подменена только модель — сценарий `chatScript` над `packages/stub-model` (маршрут
 * `stub:stand`); дома временные. Гонка вероятностная, поэтому чатов несколько (`RUNS`, по
 * умолчанию 4): в каждом после ответа на первый ход реплика человека одна, без перезагрузки; после
 * второго хода — две; после перезагрузки — те же две.
 *
 * Красный прогон: ядро стенда с прежним видом (`shownAt` → `send.at` в
 * `apps/core/src/adapters/sdk-stream/stream-view.ts`) — в части чатов реплик человека 0.
 *
 * Запуск: `node tools/qa/check-core-chat-live-first.mjs` (стенд свой, `pnpm dev` не нужен; нужен
 * `claude` в PATH). Код выхода: 0 — сходится, 1 — провал, 2 — стенд не поднялся / `claude` нет.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { FILE_MARK } from './check-core-chat.mjs';
import { uuidv7 } from './core-scenario-stand.mjs';
import { NotChecked, runOnStand, wait } from './throwaway-stand.mjs';

const CHAT_SCRIPT = resolve(dirname(fileURLToPath(import.meta.url)), 'check-core-chat.mjs');
const RUNS = Math.max(1, Number(process.env.RUNS ?? 4));

const claudeAt = (() => {
  const r = spawnSync(process.platform === 'win32' ? 'where' : 'which', ['claude'], {
    encoding: 'utf8',
  });
  return r.status === 0 ? r.stdout.split(/\r?\n/)[0].trim() : '';
})();

const git = (cwd, args) => {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (r.status) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
};

let repo = '';

await runOnStand(
  {
    label: 'core-chat-live-first',
    // Каталог claude — в конец PATH: стенд вырезает его из PATH оболочки, сеанс ядра зовёт его.
    extraPath: claudeAt ? [dirname(claudeAt)] : [],
    core: {
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
      await page.route(/\/api\/core\/commands$/, async (route) => {
        const body = route.request().postDataJSON();
        if (body?.kind === 'set-cli') {
          const taskId = body.target.taskId;
          await seedCommand(taskId, 'set-route', {
            scope: 'task',
            scopeId: taskId,
            allowedRoutes: [
              { adapter: 'claude', route: { kind: 'stub', id: 'stub:stand' }, modelPattern: '*' },
            ],
          });
          await seedCommand(taskId, 'set-model', {
            scope: 'task',
            scopeId: taskId,
            model: 'stub-model',
            effort: null,
            timing: 'now',
          });
        }
        await route.continue();
      });
      const humans = () => page.locator('[data-core-chat-human]');
      const answered = (text, seconds = 180) =>
        page
          .locator('[data-core-chat-assistant]')
          .filter({ hasText: text })
          .first()
          .waitFor({ timeout: seconds * 1000 })
          .then(() => true)
          .catch(() => false);
      // Реплики человека после паузы: следующие опросы успевают показать повтор, если он есть.
      const settledHumans = async () => {
        await wait(1500);
        return humans().allInnerTexts();
      };

      const firstLive = [];
      for (let run = 1; run <= RUNS; run += 1) {
        await page.goto(`${stand.webUrl}/core/chat?project=${encodeURIComponent(repo)}`);
        await page.locator('[data-core-chat-start]').waitFor({ timeout: 120_000 });
        await page.locator('[data-core-chat-cli] select').selectOption('claude');
        await page.locator('[data-core-chat-first] textarea').fill(`ход-1: привет, чат ${run}`);
        await page.locator('[data-core-chat-submit]').click();
        await page.waitForURL(/[?&]id=/, { timeout: 60_000 });
        const taskId = new URL(page.url()).searchParams.get('id');
        const one = await answered('ответ на ход-1');
        const live1 = one ? await settledHumans() : [];
        firstLive.push(live1.length);
        check(
          `чат ${run} (${taskId}): первый ход в живой ленте ровно один раз, без перезагрузки`,
          one && live1.length === 1 && live1[0].includes(`чат ${run}`),
          `ответ ${one}; реплики человека: ${JSON.stringify(live1)}`,
        );
        await page.locator('[data-core-chat-composer] textarea').fill(`ход-2: дальше, чат ${run}`);
        await page.locator('[data-core-chat-send]').click();
        const two = await answered('ответ на ход-2');
        const live2 = two ? await settledHumans() : [];
        check(
          `чат ${run}: после второго хода реплик человека две, по порядку`,
          two && live2.length === 2 && /ход-1/.test(live2[0]) && /ход-2/.test(live2[1]),
          `ответ ${two}; реплики человека: ${JSON.stringify(live2)}`,
        );
        await page.reload();
        await page.locator('[data-core-chat-assistant]').first().waitFor({ timeout: 60_000 });
        const reloaded = await settledHumans();
        check(
          `чат ${run}: после перезагрузки те же две реплики`,
          JSON.stringify(reloaded) === JSON.stringify(live2),
          `живьём ${JSON.stringify(live2)}; после перезагрузки ${JSON.stringify(reloaded)}`,
        );
      }
      console.log(`  реплик человека живьём после первого хода по чатам: ${firstLive.join(', ')}`);
      await page.close();
    } finally {
      await browser.close();
    }
  },
);
