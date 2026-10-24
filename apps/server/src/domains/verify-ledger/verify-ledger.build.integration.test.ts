import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

/**
 * Сборка vite в журнале проверок (владелец 19.10: гейт групп гонял одну и ту же
 * сборку на том же дереве по нескольку раз). Живые процессы node с настоящим
 * `--require` preload и настоящим git; снаружи подменён только сам vite —
 * поддельный `node_modules/vite/bin/vite.js` пишет каталог сборки и считает, сколько
 * раз его действительно запускали.
 */
/** `VL_DIR` — каталог журнала под проверкой (прогон на прежнем коде для «красного до»). */
const PRELOAD = resolve(
  process.env.VL_DIR ?? resolve(__dirname, '../../../../../tools/verify-ledger'),
  'preload.cjs',
).replace(/\\/g, '/');

/** Поддельный vite: каталог сборки из исходника, счётчик настоящих запусков, вывод. */
const FAKE_VITE = `
import fs from 'node:fs';
import path from 'node:path';
const args = process.argv.slice(2);
const at = args.indexOf('--outDir');
const conf = fs.existsSync('vite.config.ts') ? fs.readFileSync('vite.config.ts', 'utf8') : '';
const fromConf = /build:\\s*\\{\\s*outDir:\\s*'([^']+)'/.exec(conf);
const out = at >= 0 ? args[at + 1] : fromConf ? fromConf[1] : 'dist';
const src = fs.readFileSync('src.txt', 'utf8').trim();
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(path.join(out, 'assets'), { recursive: true });
fs.writeFileSync(path.join(out, 'index.html'), '<p>' + src + '</p>');
fs.writeFileSync(path.join(out, 'assets', 'app.js'), Buffer.from([0, 1, 2, 255, ...Buffer.from(src)]));
fs.appendFileSync(process.env.FAKE_COUNT, 'x');
console.log('vite build: dist/index.html built from ' + src);
`;

let root: string;
let repo: string;
let home: string;
let count: string;

function git(...args: string[]) {
  const r = spawnSync('git', args, { cwd: repo, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'cc-ledger-build-'));
  repo = join(root, 'repo');
  home = join(root, 'home');
  count = join(root, 'count.txt');
  mkdirSync(join(repo, 'node_modules/vite/bin'), { recursive: true });
  git('init', '-q');
  git('config', 'user.email', 't@example.com');
  git('config', 'user.name', 't');
  writeFileSync(join(repo, '.gitignore'), 'node_modules/\ndist/\nout/\n');
  writeFileSync(join(repo, 'package.json'), '{"name":"app","private":true}\n');
  writeFileSync(join(repo, 'src.txt'), 'A\n');
  writeFileSync(join(repo, 'node_modules/vite/bin/vite.js'), FAKE_VITE);
  git('add', '-A');
  git('commit', '-qm', 'init');
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function build(args: string[] = ['build']) {
  const r = spawnSync(process.execPath, ['node_modules/vite/bin/vite.js', ...args], {
    cwd: repo,
    encoding: 'utf8',
    env: {
      ...process.env,
      NODE_OPTIONS: `--require "${PRELOAD}"`,
      AGENTDECK_VERIFY_LEDGER_HOME: home,
      AGENTDECK_VERIFY_LEDGER: 'on',
      FAKE_COUNT: count,
    },
    timeout: 30_000,
  });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

const realRuns = () => (existsSync(count) ? readFileSync(count, 'utf8').length : 0);
const dist = (dir = 'dist') => ({
  html: readFileSync(join(repo, dir, 'index.html'), 'utf8'),
  js: [...readFileSync(join(repo, dir, 'assets', 'app.js'))],
});
const events = () =>
  existsSync(join(home, 'events.jsonl'))
    ? readFileSync(join(home, 'events.jsonl'), 'utf8')
        .trim()
        .split('\n')
        .map((l) => JSON.parse(l) as { kind: string; check?: string; reason?: string })
    : [];

describe('журнал проверок: сборка vite', () => {
  it('зелёная сборка на том же дереве не идёт второй раз: вывод и каталог сборки — записанные', () => {
    const first = build();
    expect(first.code).toBe(0);
    expect(realRuns()).toBe(1);
    const built = dist();

    // Каталог сборки снесли и подложили чужой файл — повтор обязан вернуть ровно записанный.
    rmSync(join(repo, 'dist'), { recursive: true, force: true });
    mkdirSync(join(repo, 'dist'));
    writeFileSync(join(repo, 'dist', 'stale.txt'), 'old');
    const second = build();
    expect(second.code).toBe(0);
    expect(second.err).toContain('[verify-ledger] reused green');
    expect(second.out).toBe(first.out);
    expect(realRuns()).toBe(1);
    expect(dist()).toEqual(built);
    expect(existsSync(join(repo, 'dist', 'stale.txt'))).toBe(false);
    expect(events().some((e) => e.kind === 'hit' && e.check === 'vite')).toBe(true);
  });

  it('правка исходника — сборка настоящая и с новым содержимым', () => {
    build();
    writeFileSync(join(repo, 'src.txt'), 'B\n');
    const again = build();
    expect(again.err).not.toContain('reused green');
    expect(realRuns()).toBe(2);
    expect(dist().html).toBe('<p>B</p>');
  });

  it('--outDir: каталог из ключа, повтор кладёт сборку туда же', () => {
    build(['build', '--outDir', 'out']);
    rmSync(join(repo, 'out'), { recursive: true, force: true });
    const again = build(['build', '--outDir', 'out']);
    expect(again.err).toContain('reused green');
    expect(realRuns()).toBe(1);
    expect(dist('out').html).toBe('<p>A</p>');
  });

  it('outDir в конфиге литералом внутри build — повтор кладёт сборку в этот каталог', () => {
    writeFileSync(join(repo, 'vite.config.ts'), "export default { build: { outDir: 'out' } };\n");
    git('add', '-A');
    git('commit', '-qm', 'config');
    expect(build().code).toBe(0);
    rmSync(join(repo, 'out'), { recursive: true, force: true });
    const again = build();
    expect(again.err).toContain('reused green');
    expect(realRuns()).toBe(1);
    expect(dist('out').html).toBe('<p>A</p>');
    expect(existsSync(join(repo, 'dist'))).toBe(false);
  });

  it('outDir в конфиге выражением или ключом плагина — прогон пишется, но не повторяется', () => {
    for (const config of [
      'export default { build: { outDir: process.env.OUT ?? "dist" } };\n',
      "export default { plugins: [dts({ outDir: 'types' })], build: { sourcemap: true } };\n",
      "export default { build: { outDir: 'a' }, worker: { outDir: 'b' } };\n",
    ]) {
      writeFileSync(join(repo, 'vite.config.ts'), config);
      const runs = realRuns();
      build();
      const again = build();
      expect(again.err).not.toContain('reused green');
      expect(realRuns()).toBe(runs + 2);
    }
    expect(
      events().filter((e) => e.kind === 'miss' && e.reason === 'vite outDir from config'),
    ).toHaveLength(6);
  });

  it('не сборка (dev-сервер, --watch) — не проверка, журнал молчит', () => {
    build(['build', '--watch']);
    build(['build', '--watch']);
    expect(realRuns()).toBe(2);
    expect(events().filter((e) => e.check === 'vite')).toEqual([]);
  });
});
