/**
 * Прогон параллельных веток: несколько агентов в одном репозитории.
 *
 * Проверяется то, ради чего раздел существует: копия репозитория заводится из
 * панели, открывается СВОЕЙ вкладкой (а значит, получает своего агента, свой
 * список чатов и свою точку состояния) и убирается обратно, не задев основную.
 *
 * Репозиторий тест делает свой, во временном каталоге: так прогон не зависит ни
 * от чужой истории, ни от установленного CLI, ни от того, что открыто у
 * человека, — и ничего в его проектах не трогает.
 *
 * Нужен живой `pnpm dev`. Запуск: `node tools/qa/check-worktrees.mjs`.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { chromium } from 'playwright';
import { bypassOnboarding } from './bypass-onboarding.mjs';

const BASE = process.env.APP_URL ?? 'http://localhost:8888';
const BRANCH = 'feature/qa-parallel';

const failures = [];
const check = (ok, what) => {
  console.log(`${ok ? '✓' : '✕'} ${what}`);
  if (!ok) failures.push(what);
};

/** Свой репозиторий с одним коммитом — на нём и проверяем. */
function makeRepo() {
  // Длинная форма пути обязательна: git отвечает ею, а панель сравнивает пути.
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), 'cc-qa-wt-')));
  const git = (...args) => execFileSync('git', args, { cwd: dir, stdio: 'ignore' });
  git('init', '--initial-branch=main');
  git('config', 'user.email', 'qa@example.invalid');
  git('config', 'user.name', 'QA');
  git('config', 'commit.gpgsign', 'false');
  writeFileSync(join(dir, 'file.txt'), 'первый\n');
  git('add', '-A');
  git('commit', '-m', 'первый');
  return dir;
}

function drop(target) {
  try {
    rmSync(target, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  } catch {
    // Каталог остаётся в temp и уйдёт с ОС — на результат это не влияет.
  }
}

const repo = makeRepo();
const copies = join(dirname(repo), `${basename(repo)}-worktrees`);
const copy = join(copies, 'feature-qa-parallel');

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
await bypassOnboarding(page);

// Вкладку проекта ставим прямо в хранилище: прогон про копии, а не про то, как
// открывается проект.
await page.addInitScript(
  ([path]) => {
    const id = path.replace(/\\/g, '/').toLowerCase();
    localStorage.setItem(
      'claude-control:workspace',
      JSON.stringify({ projectTabs: [{ id, path, name: 'qa-repo' }], activeTabId: id, views: {} }),
    );
  },
  [repo],
);

try {
  // networkidle не наступает: панель держит открытый поток /api/events.
  await page.goto(`${BASE}/chat`, { waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: /main/ }).first().click();

  const section = page.getByRole('dialog').getByLabel('Параллельные ветки');
  await section.waitFor({ timeout: 10_000 });
  check(
    (await section.getByTitle(repo).count()) > 0,
    'основная копия видна в списке до всякого создания',
  );

  await page.getByPlaceholder('feature/имя ветки').fill(BRANCH);
  await page.getByRole('button', { name: 'Завести копию' }).click();

  await page.waitForFunction(
    (path) =>
      (JSON.parse(localStorage.getItem('claude-control:workspace') ?? '{}').projectTabs ?? []).some(
        (tab) => tab.path === path,
      ),
    copy,
    { timeout: 30_000 },
  );
  check(true, 'копия открылась своей вкладкой проекта');
  check(existsSync(copy), `каталог копии создан рядом с проектом (${copy})`);
  check(
    (await page.getByRole('tab', { name: 'feature-qa-parallel' }).count()) > 0 ||
      (await page.getByText('feature-qa-parallel', { exact: false }).count()) > 0,
    'вкладка подписана именем копии',
  );

  // Возвращаемся в основную копию и убираем созданную.
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.evaluate(
    ([id]) => {
      const state = JSON.parse(localStorage.getItem('claude-control:workspace') ?? '{}');
      state.activeTabId = id;
      localStorage.setItem('claude-control:workspace', JSON.stringify(state));
    },
    [repo.replace(/\\/g, '/').toLowerCase()],
  );
  await page.reload({ waitUntil: 'domcontentloaded' });

  await page.getByRole('button', { name: /main/ }).first().click();
  const list = page.getByRole('dialog').getByLabel('Параллельные ветки');
  await list.waitFor({ timeout: 10_000 });
  check((await list.getByTitle(copy).count()) > 0, 'копия видна в списке из основного репозитория');

  await page.getByRole('button', { name: 'Убрать', exact: true }).first().click();
  await page.waitForFunction((path) => !document.body.innerText.includes(path), copy, {
    timeout: 30_000,
  });
  check(!existsSync(copy), 'копия убрана вместе с каталогом');
  check(existsSync(repo), 'основной репозиторий не тронут');
} finally {
  await browser.close();
  drop(copies);
  drop(repo);
}

console.log(failures.length ? `\nПровалено: ${failures.length}` : '\nВсё сошлось');
process.exit(failures.length ? 1 : 0);
