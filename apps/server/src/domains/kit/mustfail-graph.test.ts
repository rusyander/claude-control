import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { builtinKitDir } from './service.ts';

/**
 * `tools/mustfail.mjs` набора в режиме графа: команда `vitest related {file}` превращается в два
 * прогона на все файлы (база с графом и всё откачено разом) вместо прогона на каждый файл, а
 * вердикт запоминается по дереву. Доказательство — настоящий vitest над крошечным репозиторием:
 * файл с тестом на поведение, файл с тестом «для вида» и файл без тестов.
 */

const MUSTFAIL = join(builtinKitDir(), 'tools', 'mustfail.mjs');
const SERVER = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const VITEST = join(SERVER, 'node_modules', 'vitest');
const CMD = `node "${join(VITEST, 'vitest.mjs').replace(/\\/g, '/')}" related {file} --run`;
const repo = realpathSync(mkdtempSync(join(tmpdir(), 'kit-mustfail-graph-')));
afterAll(() => {
  // Сначала ссылку на vitest сервера: рекурсивное удаление не должно даже пытаться зайти в пакет.
  rmSync(join(repo, 'node_modules', 'vitest'), { force: true });
  rmSync(repo, { recursive: true, force: true });
});

const put = (rel: string, body: string) => {
  mkdirSync(dirname(join(repo, rel)), { recursive: true });
  writeFileSync(join(repo, rel), body);
};
const git = (...args: string[]) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' });
const mustfail = (...extra: string[]) => {
  const r = spawnSync(process.execPath, [MUSTFAIL, '--base', 'HEAD~1', ...extra, '--cmd', CMD], {
    cwd: repo,
    encoding: 'utf8',
    env: { ...process.env, AGENTDECK_VERIFY_LEDGER: 'off' },
  });
  return { status: r.status, out: `${r.stdout}${r.stderr}` };
};
const verdict = (out: string, file: string) =>
  out.match(new RegExp(`\\| ${file.replace('.', '\\.')}\\s*\\| (\\S+)`))?.[1];

describe('mustfail набора: режим графа vitest и память вердиктов', () => {
  // База: функции-заглушки, тест a проверяет только тип. Изменение: настоящие функции и тест a на
  // поведение. Откат a.js к базе роняет тест, откат b.js — нет (тест «для вида»), у c.js тестов нет.
  put('package.json', '{ "name": "fx", "type": "module", "private": true }\n');
  put('.gitignore', 'node_modules\n');
  put('src/a.js', 'export const add = () => 0;\n');
  put('src/b.js', 'export const mul = () => 0;\n');
  put('src/c.js', 'export const sub = () => 0;\n');
  const typeOnly = (name: string, file: string) =>
    `import { test, expect } from 'vitest';\nimport { ${name} } from './${file}';\ntest('${name}', () => { expect(typeof ${name}).toBe('function'); });\n`;
  put('src/a.test.js', typeOnly('add', 'a.js'));
  put('src/b.test.js', typeOnly('mul', 'b.js'));
  // Тесты фикстуры импортируют vitest: в temp его нет, поэтому — ссылка на пакет сервера.
  mkdirSync(join(repo, 'node_modules'));
  symlinkSync(VITEST, join(repo, 'node_modules', 'vitest'), 'junction');
  git('init', '-q');
  git('-c', 'user.email=t@t', '-c', 'user.name=t', 'add', '-A');
  git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'base');
  put('src/a.js', 'export const add = (x, y) => x + y;\n');
  put('src/b.js', 'export const mul = (x, y) => x * y;\n');
  put('src/c.js', 'export const sub = (x, y) => x - y;\n');
  put(
    'src/a.test.js',
    "import { test, expect } from 'vitest';\nimport { add } from './a.js';\ntest('add', () => { expect(add(1, 2)).toBe(3); });\n",
  );
  git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qam', 'feat');

  it('два прогона на все файлы: покрытый — RED, тест «для вида» — GREEN, без тестов — NO-BASE', () => {
    // Репозиторий новый — памяти ещё нет; `--fresh` её бы и не записал.
    const { status, out } = mustfail();

    expect(out).toContain('· baseline with graph: green');
    expect(out).toContain('· all files reverted at once: red');
    expect(verdict(out, 'src/a.js')).toBe('RED');
    expect(verdict(out, 'src/b.js')).toBe('GREEN');
    expect(verdict(out, 'src/c.js')).toBe('NO-BASE');
    // GREEN — непокрытый файл, ссылаться на прогон как на доказательство нельзя.
    expect(status).toBe(1);
  }, 120_000);

  it('то же дерево — вердикты из памяти без прогона; правка файла — прогон заново', () => {
    const again = mustfail();

    expect(again.out).toContain('3 file(s) already proven at this very tree — no run');
    expect(again.out).not.toContain('baseline with graph');
    expect(verdict(again.out, 'src/a.js')).toBe('RED');

    put('src/b.js', 'export const mul = (x, y) => y * x;\n');
    try {
      const changed = mustfail();

      expect(changed.out).toContain('· baseline with graph: green');
      expect(changed.out).not.toContain('already proven');
    } finally {
      git('checkout', '-q', 'src/b.js');
    }
  }, 120_000);
});
