import { execFileSync, spawn, spawnSync } from 'node:child_process';
import {
  existsSync,
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
const mustfail = (...extra: string[]) => mustfailWith(CMD, ...extra);
const mustfailWith = (cmd: string, ...extra: string[]) => {
  const r = spawnSync(process.execPath, [MUSTFAIL, '--base', 'HEAD~1', ...extra, '--cmd', cmd], {
    cwd: repo,
    encoding: 'utf8',
    // Замок панели снимает сам mustfail в своих прогонах; здесь — и для своего запуска.
    env: { ...process.env, AGENTDECK_VERIFY_LEDGER: 'off', AGENTDECK_VERIFY_LEDGER_LOCK: '' },
  });
  return { status: r.status, out: `${r.stdout}${r.stderr}`, pid: r.pid };
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
    // Репозиторий новый — памяти ещё нет; `--fresh` её бы и не записал. `--no-sibling`: здесь
    // проверяется сам граф, а у a.js и b.js есть свои тесты рядом — их проверку ведёт отдельный тест ниже.
    const { status, out } = mustfail('--no-sibling');

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

  it('свой тест рядом решает первым (g9): a.js — RED своим тестом, граф идёт только по b.js и c.js', () => {
    // g9 25.10: обход графа занял 105 с + 102 с на два файла, чьи тесты прямым прогоном идут ~10 с.
    const { status, out } = mustfail('--fresh');

    expect(out).toContain('· own sibling tests: 2 file(s), baseline green');
    expect(out).toMatch(/\| src\/a\.js\s*\| RED .*own test src\/a\.test\.js/);
    // b.test.js проверяет только тип: свой тест зелёный — решает граф, и он уже без a.js.
    expect(out).toContain('src/b.js → own test green — the graph decides');
    expect(out).toContain('· baseline with graph: green, test files 1');
    expect(verdict(out, 'src/b.js')).toBe('GREEN');
    expect(verdict(out, 'src/c.js')).toBe('NO-BASE');
    expect(status).toBe(1);
    expect(git('status', '--porcelain')).toBe('');
  }, 120_000);

  it('проверка без единого теста останавливается сразу (g9): `run {file}` по исходникам — exit 2, без GREEN', () => {
    // g9 25.10: `vitest run {file}` по исходным файлам при passWithNoTests — «зелёная» база без тестов,
    // каждый файл «НЕ покрыт», ложный вердикт за 13 с.
    const run = CMD.replace('related {file} --run', 'run {file} --passWithNoTests');
    const { status, out } = mustfailWith(run, '--fresh');

    expect(status).toBe(2);
    expect(out).toContain('the check ran NO test at all');
    expect(out).toContain('vitest related {file} --run');
    expect(out).not.toMatch(/\| GREEN/);
    expect(git('status', '--porcelain')).toBe('');
  }, 120_000);

  it('каждая проверка прогона получает MUSTFAIL_PID — сторож репозитория узнаёт свой прогон', () => {
    // Агенты в одной рабочей копии: сторож отказывает набору, пока ЧУЖОЙ прогон держит дерево
    // изменённым, а свои проверки пропускает по этому pid. Без него mustfail упирался бы в свой же замок.
    const probeDir = realpathSync(mkdtempSync(join(tmpdir(), 'kit-mustfail-pid-')));
    try {
      const seen = join(probeDir, 'seen.txt');
      const probe = join(probeDir, 'probe.cjs');
      writeFileSync(
        probe,
        `require('fs').appendFileSync(${JSON.stringify(seen)}, (process.env.MUSTFAIL_PID || '-') + '\\n');\n`,
      );
      const { out, pid } = mustfailWith(
        `node "${probe.replace(/\\/g, '/')}"`,
        '--files',
        'src/c.js',
        '--quick',
        '--fresh',
      );

      const pids = readFileSync(seen, 'utf8').trim().split('\n');
      expect(pids.length, out).toBeGreaterThanOrEqual(2);
      expect(
        pids.every((p) => /^\d+$/.test(p) && p === pids[0]),
        pids.join(','),
      ).toBe(true);
      // Ровно pid этого запуска: MUSTFAIL_PID внешнего прогона (тест под mustfail) пришёл бы и так.
      expect(pids[0]).toBe(String(pid));
      expect(git('status', '--porcelain')).toBe('');
    } finally {
      rmSync(probeDir, { recursive: true, force: true });
    }
  }, 120_000);

  it('--help печатает форму плана мутантов, и пример в нём — рабочий вход', () => {
    const r = spawnSync(process.execPath, [MUSTFAIL, '--help'], { encoding: 'utf8' });
    expect(r.status).toBe(0);
    for (const field of ['file', 'find', 'replace', 'test', 'spec', 'nth'])
      expect(r.stdout).toMatch(new RegExp(`^  ${field} +`, 'm'));
    const example = r.stdout.split('\n').find((l) => l.startsWith('[{'));
    const plan = JSON.parse(example ?? 'null') as Array<Record<string, unknown>>;
    expect(Array.isArray(plan)).toBe(true);
    for (const m of plan)
      for (const k of ['file', 'find', 'replace']) expect(typeof m[k]).toBe('string');
  });
});

/**
 * 29.10.2026: прогон мутантов одного агента вернул в queue.ts копию времени плана и стёр правку,
 * которую другой агент сделал в тот же файл посреди прогона. Проверка здесь сама играет второго
 * агента: пока в файле мутант (или откат к базе), она дописывает строку и краснеет.
 */
describe('mustfail набора: чужая правка посреди прогона не стирается', () => {
  const EDIT = '// PARALLEL EDIT';
  const CHECK = [
    "import { appendFileSync, readFileSync } from 'node:fs';",
    "if (readFileSync('src.js', 'utf8').includes(process.env.MARK)) {",
    `  appendFileSync('src.js', '${EDIT}\\n');`,
    '  process.exit(1);',
    '}',
    '',
  ].join('\n');
  const dirs: string[] = [];
  afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));
  const tree = () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'kit-mustfail-collide-')));
    dirs.push(dir);
    const g = (...args: string[]) =>
      execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' });
    g('init', '-q');
    g('config', 'user.email', 't@t');
    g('config', 'user.name', 't');
    writeFileSync(join(dir, 'src.js'), 'export const a = 1;\n');
    writeFileSync(join(dir, 'check.mjs'), CHECK);
    g('add', '-A');
    g('commit', '-qm', 'base');
    return dir;
  };
  const run = (dir: string, mark: string, args: string[]) => {
    const r = spawnSync(process.execPath, [MUSTFAIL, ...args, '--cmd', 'node check.mjs'], {
      cwd: dir,
      encoding: 'utf8',
      env: {
        ...process.env,
        MARK: mark,
        AGENTDECK_VERIFY_LEDGER: 'off',
        AGENTDECK_VERIFY_LEDGER_LOCK: '',
      },
    });
    return {
      status: r.status,
      out: `${r.stdout}${r.stderr}`,
      src: readFileSync(join(dir, 'src.js'), 'utf8'),
    };
  };

  it('мутант: правка остаётся в файле, прогон — exit 2 с именем мутанта, копия до плана сохранена', () => {
    const dir = tree();
    const r = run(dir, '= 3;', ['--mutate', 'src.js', '--find', '= 1', '--replace', '= 3']);
    expect(r.src).toContain(EDIT);
    expect(r.status).toBe(2);
    expect(r.out).toMatch(/CHANGED during the run/);
    expect(r.out).toContain('"= 3"');
    const kept = r.out.match(/original kept in (\S+?)\. /)?.[1] ?? '';
    expect(readFileSync(kept, 'utf8')).toBe('export const a = 1;\n');
  }, 60_000);

  it('откат к базе: правка остаётся в файле, вердикты не выдаются за чистые — exit 2', () => {
    const dir = tree();
    writeFileSync(join(dir, 'src.js'), 'export const a = 2;\n');
    const r = run(dir, '= 1;', ['--base', 'HEAD', '--files', 'src.js']);
    expect(r.src).toContain(EDIT);
    expect(r.status).toBe(2);
    expect(r.out).toMatch(/verdicts are not trustworthy/);
  }, 60_000);

  it('без чужой правки: мутант убит, файл возвращён байт в байт, резервных копий не осталось', () => {
    const dir = tree();
    writeFileSync(
      join(dir, 'check.mjs'),
      "import { readFileSync } from 'node:fs';\nif (readFileSync('src.js', 'utf8').includes('= 3')) process.exit(1);\n",
    );
    const r = run(dir, 'never', ['--mutate', 'src.js', '--find', '= 1', '--replace', '= 3']);
    expect(r.status).toBe(0);
    expect(r.src).toBe('export const a = 1;\n');
    expect(r.out).toMatch(/1 killed · 0 survived/);
  }, 60_000);

  it('второй прогон, начатый под долгой базой первого, отказывает сразу — дерево занято до первого прогона проверки', async () => {
    const dir = tree();
    // База первого прогона идёт 3 с и оставляет метку: второй стартует строго под ней.
    writeFileSync(
      join(dir, 'check.mjs'),
      [
        "import { appendFileSync, readFileSync } from 'node:fs';",
        'appendFileSync(process.env.SEEN, `${process.env.WHO}\\n`);',
        "if (readFileSync('src.js', 'utf8').includes('= 3')) process.exit(1);",
        'await new Promise((r) => setTimeout(r, 3000));',
        '',
      ].join('\n'),
    );
    const seen = join(dir, '..', `${dir.split(/[\\/]/).pop()}-seen`);
    dirs.push(seen);
    const env = {
      ...process.env,
      SEEN: seen,
      AGENTDECK_VERIFY_LEDGER: 'off',
      AGENTDECK_VERIFY_LEDGER_LOCK: '',
    };
    const args = [MUSTFAIL, '--mutate', 'src.js', '--find', '= 1', '--replace', '= 3'];
    const a = spawn(process.execPath, [...args, '--cmd', 'node check.mjs'], {
      cwd: dir,
      env: { ...env, WHO: 'a' },
    });
    const aDone = new Promise<number | null>((done) => a.on('exit', done));
    const t0 = Date.now();
    while (!existsSync(seen) && Date.now() - t0 < 20_000)
      await new Promise((r) => setTimeout(r, 50));
    const b = spawnSync(process.execPath, [...args, '--cmd', 'node check.mjs'], {
      cwd: dir,
      env: { ...env, WHO: 'b' },
      encoding: 'utf8',
    });
    expect(`${b.stdout}${b.stderr}`).toMatch(/another mustfail run \(pid \d+/);
    expect(b.status).toBe(2);
    expect(await aDone).toBe(0);
    expect(readFileSync(join(dir, 'src.js'), 'utf8')).toBe('export const a = 1;\n');
    // Второй не запустил проверку ни разу: ни своей базы, ни мутанта.
    const runs = readFileSync(seen, 'utf8').trim().split('\n');
    expect(runs).toContain('a');
    expect(runs).not.toContain('b');
  }, 60_000);
});
