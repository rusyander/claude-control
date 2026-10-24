import { execFileSync, spawnSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
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
  // unlink, а не rmSync: на Windows ссылка — junction, и rmSync без recursive отказывает
  // «Path is a directory», роняя весь файл после зелёных тестов.
  try {
    unlinkSync(join(repo, 'node_modules', 'vitest'));
  } catch {
    // ссылки нет — тест упал раньше, чем её создал
  }
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
    // Замок панели снимает сам mustfail в своих прогонах; здесь — и для своего запуска.
    env: { ...process.env, AGENTDECK_VERIFY_LEDGER: 'off', AGENTDECK_VERIFY_LEDGER_LOCK: '' },
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

  it('вход с замком журнала (F-30): прогоны мутантов идут через обычный preload.cjs', () => {
    // Панель кладёт в NODE_OPTIONS `bin/preload-locked.cjs` — замок, который окружение не снимает.
    // Мутантам он вернул бы зелёный повтор с немутированного дерева, поэтому mustfail меняет вход.
    const bin = join(repo, '..', `${repo.split(/[\\/]/).pop()}-ledger`, 'bin');
    mkdirSync(bin, { recursive: true });
    const log = join(bin, 'loads.log').replace(/\\/g, '/');
    // Каждый node пишет, через какой вход стартовал и какой замок/режим журнала увидел (F-81).
    const mark = (word: string) =>
      `const e = process.env; require('node:fs').appendFileSync(${JSON.stringify(log)}, ` +
      `'${word}:' + (e.AGENTDECK_VERIFY_LEDGER_LOCK ?? '') + ':' + (e.AGENTDECK_VERIFY_LEDGER ?? '') + '\\n');\n`;
    writeFileSync(join(bin, 'preload-locked.cjs'), mark('locked'));
    writeFileSync(join(bin, 'preload.cjs'), mark('plain'));
    const entry = join(bin, 'preload-locked.cjs').replace(/\\/g, '/');
    put('src/b.js', 'export const mul = (x, y) => (y * x);\n');
    try {
      const r = spawnSync(process.execPath, [MUSTFAIL, '--base', 'HEAD~1', '--cmd', CMD], {
        cwd: repo,
        encoding: 'utf8',
        // Окружение панели: замок стоит, журнал включён — mustfail обязан снять оба сам.
        env: {
          ...process.env,
          NODE_OPTIONS: `--require "${entry}"`,
          AGENTDECK_VERIFY_LEDGER_LOCK: '1',
          AGENTDECK_VERIFY_LEDGER: 'on',
        },
      });
      const loads = readFileSync(log, 'utf8').trim().split('\n');
      expect(`${r.stdout}${r.stderr}`).toContain('· baseline with graph: green');
      // Только сам mustfail стартовал через вход с замком; каждый node прогона — через обычный,
      // с пустым замком и выключенным журналом.
      expect(loads.filter((w) => w.startsWith('locked:'))).toEqual(['locked:1:on']);
      const plain = loads.filter((w) => w.startsWith('plain:'));
      expect(plain.length).toBeGreaterThan(0);
      expect(new Set(plain)).toEqual(new Set(['plain::off']));
    } finally {
      git('checkout', '-q', 'src/b.js');
      rmSync(dirname(bin), { recursive: true, force: true });
    }
  }, 120_000);
});
