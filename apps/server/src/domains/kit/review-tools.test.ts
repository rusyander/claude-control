import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { builtinKitDir } from './service.ts';

/**
 * Инструменты ревью из набора — настоящие файлы набора. Выбор путей проверки не должен молча
 * сметать ноль файлов, а позиция треда на диапазон строк должна нести line_range с кодами строк
 * GitLab. Против живого GitLab позиция не проверялась: форма — по документации REST.
 */

const TOOLS = join(builtinKitDir(), 'tools');
const root = mkdtempSync(join(tmpdir(), 'kit-review-tools-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const git = (repo: string, ...a: string[]): string =>
  spawnSync('git', ['-C', repo, ...a], { encoding: 'utf8' }).stdout.trim();
const sha1 = (s: string): string => createHash('sha1').update(s).digest('hex');
const nums = (n: number): string[] => Array.from({ length: n }, (_, i) => `line ${i + 1}`);

const put = (repo: string, file: string, lines: string[]): void => {
  mkdirSync(dirname(join(repo, file)), { recursive: true });
  writeFileSync(join(repo, file), lines.join('\n') + '\n');
};
const makeRepo = (name: string): string => {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q');
  git(dir, 'config', 'user.email', 't@t');
  git(dir, 'config', 'user.name', 't');
  return dir;
};
const commit = (repo: string, msg: string): string => {
  git(repo, 'add', '-A');
  git(repo, 'commit', '-qm', msg);
  return git(repo, 'rev-parse', 'HEAD');
};

const sweep = (await import(pathToFileURL(join(TOOLS, 'review-sweep.mjs')).href)) as {
  resolvePaths: (
    raw: string,
    files: string[],
    viaGit?: (p: string) => number,
  ) => { paths: string[]; unmatched: string[] };
};

describe('review-sweep: --paths', () => {
  const files = ['src/a.go', 'my docs/a.md', 'my docs/b.md', 'other/x.go'];

  it('сопоставляет путь с пробелом целиком', () => {
    expect(sweep.resolvePaths('my docs/a.md', files)).toEqual({
      paths: ['my docs/a.md'],
      unmatched: [],
    });
  });

  it('делит список через запятую и перевод строки', () => {
    expect(sweep.resolvePaths('src/a.go,other/x.go\nmy docs', files).paths).toEqual([
      'src/a.go',
      'other/x.go',
      'my docs',
    ]);
  });

  it('читает список через пробел, самый длинный путь первым', () => {
    expect(sweep.resolvePaths('my docs src/a.go', files)).toEqual({
      paths: ['my docs', 'src/a.go'],
      unmatched: [],
    });
  });

  it('несовпавший путь попадает в unmatched, а не пропадает молча', () => {
    expect(sweep.resolvePaths('src/a.go,nope/missing.go', files)).toEqual({
      paths: ['src/a.go'],
      unmatched: ['nope/missing.go'],
    });
  });

  it('CLI: путь вне диффа — код 2, «swept 0 of N», пустой stdout', () => {
    const repo = makeRepo('sweep');
    put(repo, 'src/a.go', ['package a']);
    const base = commit(repo, 'base');
    put(repo, 'src/a.go', ['package a', 'func F() {}']);
    commit(repo, 'head');
    const r = spawnSync(
      process.execPath,
      [
        join(TOOLS, 'review-sweep.mjs'),
        'sweep',
        '--repo',
        repo,
        '--base',
        base,
        '--paths',
        'nope/x.go',
      ],
      { encoding: 'utf8' },
    );
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/swept 0 of 1 given/);
    expect(r.stdout.trim()).toBe('');
  });

  it('CLI: неизвестная база — код 2, а не «чистый» пустой дифф', () => {
    const repo = makeRepo('sweep-base');
    put(repo, 'a.go', ['package a']);
    commit(repo, 'base');
    const r = spawnSync(
      process.execPath,
      [join(TOOLS, 'review-sweep.mjs'), 'sweep', '--repo', repo, '--base', 'deadbeef00'],
      { encoding: 'utf8' },
    );
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/not a commit/);
  });
});

describe('review-position', () => {
  const base = nums(40);
  const head = [...base];
  head.splice(29, 1);
  head.splice(20, 0, 'ADDED A', 'ADDED B');
  head.splice(9, 1, 'CHANGED 10a', 'CHANGED 10b');
  const repo = makeRepo('position');
  put(repo, 'src/a.txt', base);
  const B = commit(repo, 'base');
  put(repo, 'src/a.txt', head);
  const H = commit(repo, 'head');

  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the tool prints a free-form position JSON the tests probe by path
  type Out = { status: number | null; stderr: string; json: Record<string, any> | null };
  const pos = (lines: string, ...extra: string[]): Out => {
    const r = spawnSync(
      process.execPath,
      [
        join(TOOLS, 'review-position.mjs'),
        ...['--repo', repo, '--file', 'src/a.txt', '--lines', lines],
        ...['--base-sha', B, '--start-sha', B, '--head-sha', H, ...extra],
      ],
      { encoding: 'utf8' },
    );
    let json: Out['json'];
    try {
      json = JSON.parse(r.stdout) as Out['json'];
    } catch {
      json = null;
    }
    return { status: r.status, stderr: r.stderr, json };
  };
  const code = (o: number, n: number): string => `${sha1('src/a.txt')}_${o}_${n}`;

  it('одна строка — обычная позиция без line_range', () => {
    const r = pos('10');
    expect(r.status).toBe(0);
    expect(r.json?.position).toMatchObject({ new_line: 10, old_line: null, position_type: 'text' });
    expect(r.json?.position.line_range).toBeUndefined();
  });

  it('диапазон добавленных строк — line_range, счётчик старой строки следующий', () => {
    const r = pos('10-11');
    expect(r.json?.position.new_line).toBe(11);
    expect(r.json?.position.line_range.start).toMatchObject({
      line_code: code(11, 10),
      type: 'new',
    });
    expect(r.json?.position.line_range.end.line_code).toBe(code(11, 11));
    expect(r.json?.github).toMatchObject({ start_line: 10, line: 11, side: 'RIGHT' });
  });

  it('чистая вставка: старый счётчик = последняя старая строка + 1', () => {
    const r = pos('22-23');
    expect(r.json?.position.line_range.start.line_code).toBe(code(21, 22));
    expect(r.json?.position.line_range.end.line_code).toBe(code(21, 23));
  });

  it('контекстные строки сдвигаются на прошлые хунки', () => {
    const r = pos('25-26');
    expect(r.json?.position.line_range.start.line_code).toBe(code(22, 25));
    expect(r.json?.position.line_range.end.line_code).toBe(code(23, 26));
  });

  it('удалённая строка — сторона old', () => {
    const r = pos('30', '--side', 'old');
    expect(r.json?.position).toMatchObject({ old_line: 30, new_line: null });
    expect(r.json?.github.side).toBe('LEFT');
  });

  it('строка вне диффа — код 3, подсказка про «вне диффа»', () => {
    const r = pos('15');
    expect(r.status).toBe(3);
    expect(r.stderr).toMatch(/outside the diff/);
  });

  it('за концом файла — код 2', () => {
    expect(pos('40-60').status).toBe(2);
  });

  it('неизвестный sha — код 2', () => {
    const r = spawnSync(
      process.execPath,
      [
        join(TOOLS, 'review-position.mjs'),
        ...['--repo', repo, '--file', 'src/a.txt', '--lines', '10'],
        ...['--base-sha', 'deadbeef00', '--head-sha', H],
      ],
      { encoding: 'utf8' },
    );
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/not a commit/);
  });
});
