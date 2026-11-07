/**
 * Живая лента чата на ядре: первый ход человека виден без перезагрузки и ровно один раз (зона C,
 * проход 8; находка съёмки контура «живьём 0, после перезагрузки 1»). С этапа 11 (W3-17a) чат один —
 * `/chat`: прежний экран `/core/chat` свёрнут в него, и проверка идёт там.
 *
 * Причина была в ядре: насос пишет отправку на своё смещение `stdout.log`, а оно отстаёт от файла.
 * Опрос вида, успевший раньше записи отправки, уводил курсор за это смещение — и ход человека в
 * живую ленту больше не попадал. Теперь отправка несёт `seen` — длину вывода на миг записи — и
 * встаёт в ленту не раньше неё.
 *
 * Дорога настоящая: браузер → Vite → панель → ядро → хост сеансов → настоящий `claude` из PATH.
 * Подменена только модель — сценарий `chatScript` (`check-core-chat.mjs`) над `packages/stub-model`
 * по адресу из личного settings.json стенда; дома временные. Гонка вероятностная, поэтому чатов
 * несколько (`RUNS`, по умолчанию 4): в каждом после ответа на первый ход реплика человека одна, без
 * перезагрузки; после второго хода — две; после перезагрузки — те же две.
 *
 * Запуск: `node tools/qa/check-core-chat-live-first.mjs` (стенд свой, `pnpm dev` не нужен; нужен
 * `claude` в PATH). Код выхода: 0 — сходится, 1 — провал, 2 — стенд не поднялся / `claude` нет.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { chromium } from 'playwright';
import { startStubModel } from '../../packages/stub-model/src/index.mjs';
import { FILE_MARK, chatScript } from './check-core-chat.mjs';
import { openProjectChat } from './chat-walk.mjs';
import { NotChecked, runOnStand, wait } from './throwaway-stand.mjs';

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
let file = 'notes.txt';
const model = await startStubModel({ script: (ctx) => chatScript({ file })(ctx) });
const stubEnv = { ANTHROPIC_BASE_URL: model.baseUrl, ANTHROPIC_API_KEY: 'stand-stub-key' };

await runOnStand(
  {
    label: 'core-chat-live-first',
    // Каталог claude — в конец PATH: стенд вырезает его из PATH оболочки, сеанс ядра зовёт его.
    extraPath: claudeAt ? [dirname(claudeAt)] : [],
    env: stubEnv,
    core: true,
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
    const browser = await chromium.launch();
    try {
      if (!claudeAt) throw new NotChecked('claude не найден в PATH — сеанс ядра не запустить');
      // Вход claude стенда — адрес заглушки в `env` личного settings.json: маршрут задачи без
      // контура — вход CLI, и ядро передаёт личный слой как есть.
      const settingsPath = join(stand.cfg, 'settings.json');
      const settings = existsSync(settingsPath)
        ? JSON.parse(readFileSync(settingsPath, 'utf8'))
        : {};
      writeFileSync(
        settingsPath,
        `${JSON.stringify({ ...settings, env: { ...settings.env, ...stubEnv } }, null, 2)}\n`,
      );

      const page = await openProjectChat(stand, browser, repo, 'repo');
      const input = page.locator('textarea[data-chat-input]');
      // Реплика человека — пузырь ленты с его словами (ответ модели — «ответ на ход-N», слов
      // человека в нём нет).
      const humans = (run) =>
        page.locator('[data-feed-message]').filter({ hasText: `, чат ${run}` });
      const answered = (text, seconds = 180) =>
        page
          .locator('[data-feed-message]')
          .filter({ hasText: text })
          .first()
          .waitFor({ timeout: seconds * 1000 })
          .then(() => true)
          .catch(() => false);
      // Реплики человека после паузы: следующие опросы успевают показать повтор, если он есть.
      const settledHumans = async (run) => {
        await wait(1500);
        return humans(run).allInnerTexts();
      };

      const firstLive = [];
      for (let run = 1; run <= RUNS; run += 1) {
        await page.getByRole('button', { name: 'Новый чат', exact: true }).first().click();
        await input.waitFor({ timeout: 60_000 });
        await input.fill(`ход-1: привет, чат ${run}`);
        await input.press('Enter');
        const one = await answered('ответ на ход-1');
        const live1 = one ? await settledHumans(run) : [];
        firstLive.push(live1.length);
        const conv = new URL(page.url()).searchParams.get('id');
        check(
          `чат ${run} (${conv ?? '—'}): первый ход в живой ленте ровно один раз, без перезагрузки`,
          one && live1.length === 1,
          `ответ ${one}; реплики человека: ${JSON.stringify(live1)}`,
        );
        await input.fill(`ход-2: дальше, чат ${run}`);
        await input.press('Enter');
        const two = await answered('ответ на ход-2');
        const live2 = two ? await settledHumans(run) : [];
        check(
          `чат ${run}: после второго хода реплик человека две, по порядку`,
          two && live2.length === 2 && /ход-1/.test(live2[0]) && /ход-2/.test(live2[1]),
          `ответ ${two}; реплики человека: ${JSON.stringify(live2)}`,
        );
        await page.reload();
        await page.locator('[data-feed-message]').first().waitFor({ timeout: 60_000 });
        const reloaded = await settledHumans(run);
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
      await model.close();
    }
  },
);
