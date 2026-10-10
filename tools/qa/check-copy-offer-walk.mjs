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
 * - копия открылась своей вкладкой (Ф-6) — разговор в её списке, полоса ветки
 *   показывает ветку копии; следующее сообщение — ход в копии, ворот второй
 *   раз нет (дом разговора — копия, `sessionHome`);
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
      // Ф-6: копия из карточки открывается своей вкладкой — как из окна
      // «Параллельные ветки», — и разговор, переехавший в неё, виден уже там.
      const copyId = copy.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
      const activeTab = () =>
        page.evaluate(
          () => JSON.parse(localStorage.getItem('agentdeck:workspace') ?? '{}').activeTabId ?? '',
        );
      let active = '';
      for (let i = 0; i < 40 && copy && active !== copyId; i += 1) {
        active = await activeTab();
        if (active !== copyId) await wait(250);
      }
      check(
        'копия открылась своей вкладкой и стала активной',
        Boolean(copy) && active === copyId,
        active,
      );
      if (process.env.SHOTS)
        await page.screenshot({ path: join(process.env.SHOTS, 'copy-offer-tab.png') });
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
      // Во вкладке копии разговор — свой: он в её списке, полоса ветки — ветка копии.
      const counter = page.getByText(/Показано \d+ из \d+/).first();
      let shownCount = '';
      for (let i = 0; i < 60 && !/Показано 1 из 1/.test(shownCount); i += 1) {
        shownCount = await counter.innerText().catch(() => '');
        if (!/Показано 1 из 1/.test(shownCount)) await wait(250);
      }
      check('разговор в списке вкладки копии', /Показано 1 из 1/.test(shownCount), shownCount);
      const branchBar = await page
        .locator('main')
        .getByText(branch, { exact: true })
        .count()
        .catch(() => 0);
      check('полоса ветки во вкладке копии — ветка копии', branchBar > 0, branch);
      if (process.env.SHOTS)
        await page.screenshot({ path: join(process.env.SHOTS, 'copy-offer-tab-settled.png') });

      // Переезд не на один ход: следующее сообщение человека идёт в копию, а не
      // обратно в основную копию к тем же воротам.
      const editsBefore = edits().length;
      await input.fill('ПРАВКА: допиши второй абзац');
      await input.press('Enter');
      let next;
      for (let i = 0; i < 240 && !next; i += 1) {
        next = edits().slice(editsBefore)[0];
        if (!next) await wait(250);
      }
      check(
        'следующее сообщение — ход в копии',
        Boolean(next) && same(next.cwd, copy),
        JSON.stringify(next ?? null),
      );
      for (let i = 0; i < 40; i += 1) {
        const allow = page.getByRole('button', { name: 'Разрешить', exact: true }).first();
        if (await allow.isVisible().catch(() => false)) await allow.click();
        await wait(250);
      }
      check(
        'ворот ветки второй раз нет',
        (await page.getByText('Первая правка — где работаем?').count()) === 0,
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
