import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { chooseE2eFolder, createE2eFolder, e2eFolderView } from './e2e-folder.ts';
import { viewGitContext } from './impact.ts';

/**
 * F-159: вид папки e2e строится на каждый запрос вида раздела — обход спек,
 * конфиги монорепозитория и два запуска git синхронно в цикле событий (замер:
 * 80 мс на 400 спек, 107 мс на 2000). Повтор при нетронутом диске отвечает
 * запомненным, а любая правка, которую видно по времени каталога или файла,
 * даёт свежий вид сразу.
 */
const PAST = new Date(Date.now() - 60_000);

/** Состарить всё дерево: свежая запись не должна выглядеть правкой посреди обхода. */
function age(dir: string): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory() && entry.name !== '.git') age(path);
    else if (!entry.isDirectory()) utimesSync(path, PAST, PAST);
  }
  utimesSync(dir, PAST, PAST);
}

const SPEC = "import { test } from '@playwright/test';\ntest('a', async () => {});\n";

describe('вид папки e2e: запомненный, пока диск не менялся', () => {
  let root = '';
  let appData = '';

  beforeEach(() => {
    root = realpathSync.native(mkdtempSync(join(tmpdir(), 'cc-e2e-memo-')));
    appData = realpathSync.native(mkdtempSync(join(tmpdir(), 'cc-e2e-memo-data-')));
    spawnSync('git', ['init', '-q'], { cwd: root });
    mkdirSync(join(root, 'e2e', 'cart'), { recursive: true });
    writeFileSync(join(root, 'e2e', 'cart', 'add.spec.ts'), SPEC);
    age(root);
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    rmSync(appData, { recursive: true, force: true });
  });

  it('нетронутый диск — повтор без обхода: подпись та же, ответ прежний', () => {
    expect(e2eFolderView(root, appData)).toMatchObject({ state: 'found', dir: 'e2e', specs: 1 });
    // Файл добавлен, а время каталога возвращено: по подписи диск не менялся.
    // Обход дерева нашёл бы две спеки; запомненный вид отвечает одной.
    const cart = join(root, 'e2e', 'cart');
    const before = statSync(cart);
    writeFileSync(join(cart, 'remove.spec.ts'), SPEC);
    utimesSync(cart, before.atime, before.mtime);
    expect(e2eFolderView(root, appData).specs).toBe(1);
  });

  it('новый файл теста, новая папка кандидат и правка конфига видны сразу', () => {
    expect(e2eFolderView(root, appData).specs).toBe(1);
    writeFileSync(join(root, 'e2e', 'cart', 'remove.spec.ts'), SPEC);
    expect(e2eFolderView(root, appData).specs).toBe(2);

    mkdirSync(join(root, 'apps', 'web', 'tests', 'e2e'), { recursive: true });
    expect(e2eFolderView(root, appData).candidates).toEqual(['apps/web/tests/e2e']);

    mkdirSync(join(root, 'suite'));
    writeFileSync(join(root, 'suite', 'x.spec.ts'), SPEC);
    writeFileSync(join(root, 'playwright.config.ts'), "export default { testDir: './suite' };\n");
    expect(e2eFolderView(root, appData)).toMatchObject({ dir: 'suite', origin: 'config' });
    writeFileSync(join(root, 'playwright.config.ts'), "export default { testDir: './e2e' };\n");
    expect(e2eFolderView(root, appData)).toMatchObject({ dir: 'e2e', origin: 'config' });
  });

  it('выбор человека и заведённая панелью папка — свой вид сразу', () => {
    mkdirSync(join(root, 'apps', 'web', 'e2e'), { recursive: true });
    expect(e2eFolderView(root, appData).dir).toBe('e2e');
    chooseE2eFolder(appData, root, 'apps/web/e2e');
    expect(e2eFolderView(root, appData).dir).toBe('apps/web/e2e');

    const bare = realpathSync.native(mkdtempSync(join(tmpdir(), 'cc-e2e-memo-bare-')));
    try {
      expect(e2eFolderView(bare, appData).state).toBe('missing');
      createE2eFolder(appData, bare, new Date().toISOString());
      expect(e2eFolderView(bare, appData)).toMatchObject({ state: 'created', dir: 'e2e' });
    } finally {
      rmSync(bare, { recursive: true, force: true });
    }
  });

  it('ветка и коммит вида: коммит и переключение ветки видны сразу, иначе без git', () => {
    const git = (...args: string[]) =>
      spawnSync('git', ['-c', 'user.email=qa@example.com', '-c', 'user.name=qa', ...args], {
        cwd: root,
        encoding: 'utf8',
      }).stdout.trim();
    git('add', '-A');
    git('commit', '-qm', 'one');
    const first = viewGitContext(root);
    expect(first.commit).toBe(git('rev-parse', '--short', 'HEAD'));

    git('commit', '--allow-empty', '-qm', 'two');
    const second = viewGitContext(root);
    expect(second.commit).toBe(git('rev-parse', '--short', 'HEAD'));
    expect(second.commit).not.toBe(first.commit);

    git('checkout', '-q', '-b', 'feature/memo');
    const head = join(root, '.git', 'HEAD');
    // Свежая правка посреди расчёта не запоминается — состарить, как в жизни.
    for (const path of [head, join(root, '.git', 'refs', 'heads', 'feature', 'memo'), root]) {
      utimesSync(path, PAST, PAST);
    }
    expect(viewGitContext(root)).toMatchObject({ branch: 'feature/memo', commit: second.commit });

    // HEAD переписан, а время возвращено: подпись та же — ответ из памяти.
    const stamp = statSync(head);
    writeFileSync(head, 'ref: refs/heads/other\n');
    utimesSync(head, stamp.atime, stamp.mtime);
    expect(viewGitContext(root).branch).toBe('feature/memo');
  });

  it('ответ — копия: правка вызывающим не портит запомненное', () => {
    const first = e2eFolderView(root, appData);
    first.specs = 99;
    expect(e2eFolderView(root, appData).specs).toBe(1);
  });
});
