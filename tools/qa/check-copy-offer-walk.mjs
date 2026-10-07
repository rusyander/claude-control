/**
 * Копия ветки из чата (Ф22): кейс projects-copies-003, ни разу не гонявшийся.
 *
 * Одноразовая панель над временным домом и настоящий git-репозиторий во
 * временной папке; подменена только модель — фальшивый `claude`
 * (`fake-cli-chat-basics.mjs`, сценарий `ПРАВКА`): он просит права на запись
 * файла через НАСТОЯЩИЙ мост панели. Всё остальное настоящее: ворота ветки в
 * маршруте прав, `git worktree add`, перезапуск разговора в копии, вкладка
 * копии, «Убрать» в окне параллельных веток.
 *
 * - «Правки в основной копии проекта» выключены (по умолчанию) — первая правка
 *   в основной копии придержана карточкой «Первая правка — где работаем?»;
 * - «Завести копию и продолжить в ней» — копия на диске (`git worktree list`),
 *   разговор продолжается в ней: тот же ход приходит процессу с рабочей папкой
 *   копии, файл записан в копии, основная копия чиста (`git status`);
 * - разговор тот же: второго чата не появилось, ответ из копии в той же ленте;
 * - «Убрать вместе с правками» — копии нет ни в `git worktree list`, ни на диске
 *   рабочим деревом; основная копия не тронута.
 *
 * Запуск: node tools/qa/check-copy-offer-walk.mjs   (браузеры: pnpm qa:setup)
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { chromium } from 'playwright';
import { runOnStand, wait } from './throwaway-stand.mjs';
import { FAKE_BASICS_CLI } from './fake-cli-chat-basics.mjs';
import { readTurns } from './fake-cli-append.mjs';
import { openProjectChat } from './chat-walk.mjs';

const git = (dir, ...args) =>
  execFileSync('git', args, { cwd: dir, encoding: 'utf8', windowsHide: true });
const same = (a, b) =>
  a.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase() ===
  b.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();

let repo = '';

await runOnStand(
  {
    label: 'copy-offer',
    fakeCli: { claude: FAKE_BASICS_CLI },
    seed: ({ root }) => {
      repo = join(root, 'qa-repo');
      mkdirSync(repo, { recursive: true });
      git(repo, 'init', '-b', 'main');
      git(repo, 'config', 'user.email', 'qa@example.com');
      git(repo, 'config', 'user.name', 'qa');
      git(repo, 'config', 'core.longpaths', 'true');
      writeFileSync(join(repo, 'README.md'), '# qa\n');
      git(repo, 'add', '.');
      git(repo, 'commit', '-m', 'first');
    },
  },
  async (stand, check) => {
    const browser = await chromium.launch();
    const edits = () => readTurns(stand.read, stand.bin).filter((turn) => turn.scenario === 'edit');
    const worktrees = () =>
      git(repo, 'worktree', 'list', '--porcelain')
        .split('\n')
        .filter((line) => line.startsWith('worktree '))
        .map((line) => line.slice('worktree '.length).trim());
    try {
      const page = await openProjectChat(stand, browser, repo, 'qa-repo');
      const input = page.locator('textarea[data-chat-input]');
      await input.fill('ПРАВКА: допиши note.txt');
      await input.press('Enter');

      const gate = page.getByText('Первая правка — где работаем?').first();
      const shown = await gate
        .waitFor({ timeout: 60_000 })
        .then(() => true)
        .catch(() => false);
      check(
        'первая правка в основной копии придержана карточкой',
        shown,
        `ходы CLI: ${JSON.stringify(readTurns(stand.read, stand.bin))}`,
      );
      if (!shown && process.env.SHOTS)
        await page.screenshot({ path: join(process.env.SHOTS, 'copy-offer-gate.png') });
      check('файл в основной копии не записан', !existsSync(join(repo, 'note.txt')));
      const branchField = page.getByLabel('Ветка для копии').first();
      const branch = (await branchField.inputValue().catch(() => '')).trim();
      check('карточка предлагает ветку для копии', branch.length > 0, branch);

      await page.getByRole('button', { name: 'Завести копию и продолжить в ней' }).first().click();
      let moved;
      for (let i = 0; i < 240 && !moved; i += 1) {
        moved = edits().find((turn) => !same(turn.cwd, repo));
        if (!moved) await wait(250);
      }
      if (!moved && process.env.SHOTS) {
        await page.screenshot({ path: join(process.env.SHOTS, 'copy-offer-moved.png') });
        console.log(stand.log().slice(-3000));
      }
      const copy = moved?.cwd ?? '';
      check('разговор поднялся в копии и повторил правку', Boolean(moved), JSON.stringify(edits()));
      check(
        'копия лежит рядом с проектом, в «<репозиторий>-worktrees»',
        Boolean(copy) && same(dirname(copy), join(dirname(repo), `${basename(repo)}-worktrees`)),
        copy,
      );
      check(
        'копия в git worktree list',
        worktrees().some((path) => same(path, copy)),
        worktrees().join(' | '),
      );
      // В копии запись — уже не основная копия: карточка прав (если она есть) — обычная.
      for (let i = 0; i < 60 && copy && !existsSync(join(copy, 'note.txt')); i += 1) {
        const allow = page.getByRole('button', { name: 'Разрешить', exact: true }).first();
        if (await allow.isVisible().catch(() => false)) await allow.click();
        await wait(250);
      }
      check('файл записан в копии', Boolean(copy) && existsSync(join(copy, 'note.txt')));
      check(
        'основная копия не тронута: git status чист, файла нет',
        git(repo, 'status', '--porcelain').trim() === '' && !existsSync(join(repo, 'note.txt')),
        git(repo, 'status', '--porcelain'),
      );
      if (copy) {
        check(
          'копия на своей ветке',
          git(copy, 'rev-parse', '--abbrev-ref', 'HEAD').trim() === branch,
          git(copy, 'rev-parse', '--abbrev-ref', 'HEAD'),
        );
      }
      // Тот же разговор, а не новый: настоящий CLI дописывает --resume в прежний
      // файл сессии и из папки копии (проверено на 2.1.286), фальшивый — так же.
      const chats = (await stand.api('/chats')).body;
      const list0 = Array.isArray(chats) ? chats : (chats?.chats ?? chats?.items ?? []);
      check(
        'разговор продолжился тем же чатом, второго не появилось',
        list0.length === 1,
        JSON.stringify(list0.map((chat) => chat.title ?? chat.id)),
      );
      const feed = await page.locator('main').innerText();
      check(
        'в ленте того же чата — ответ из копии',
        feed.includes('ПРАВКА: допиши note.txt') && feed.includes('Правка записана.'),
        feed.replace(/\s+/g, ' ').slice(-400),
      );

      // Уборка — из окна параллельных веток основной копии.
      await page.goto(`${stand.webUrl}/`, { waitUntil: 'domcontentloaded' });
      await page.evaluate((path) => {
        const id = path.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
        const saved = JSON.parse(localStorage.getItem('agentdeck:workspace') ?? '{}');
        localStorage.setItem('agentdeck:workspace', JSON.stringify({ ...saved, activeTabId: id }));
      }, repo);
      await page.goto(`${stand.webUrl}/chat`, { waitUntil: 'domcontentloaded' });
      await page.getByRole('button', { name: /main/ }).first().click();
      const list = page.getByRole('dialog').getByLabel('Параллельные ветки');
      await list.waitFor({ timeout: 20_000 });
      await list.getByText('agent/', { exact: false }).first().waitFor({ timeout: 20_000 });
      // Простаивающий агент копии — «ничего не происходит»: метки нет, а не сырой ключ словаря.
      const rows = await list.innerText();
      check(
        'строка копии без сырого ключа статуса',
        !rows.includes('workspace.status'),
        rows.replace(/\s+/g, ' ').slice(0, 300),
      );
      await list.getByRole('button', { name: 'Убрать', exact: true }).first().click();
      const force = page.getByRole('button', { name: 'Убрать вместе с правками' }).first();
      await force.waitFor({ timeout: 20_000 });
      check('копия с правкой: панель предлагает убрать вместе с правками', true);
      await force.click();
      await wait(3000);
      if (process.env.SHOTS)
        await page.screenshot({ path: join(process.env.SHOTS, 'copy-offer-remove.png') });
      for (let i = 0; i < 120 && worktrees().some((path) => same(path, copy)); i += 1)
        await wait(250);
      check(
        'копии нет в git worktree list',
        !worktrees().some((path) => same(path, copy)),
        worktrees().join(' | '),
      );
      check('рабочее дерево копии убрано', !existsSync(join(copy, 'note.txt')));
      check(
        'основная копия после уборки чиста',
        git(repo, 'status', '--porcelain').trim() === '' && existsSync(join(repo, 'README.md')),
      );
      check('страница без ошибок', page.errors.length === 0, page.errors.join('\n'));
    } finally {
      await browser.close();
    }
  },
);
