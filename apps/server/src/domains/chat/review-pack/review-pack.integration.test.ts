import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { reviewPackCommand } from './review-pack.ts';

/**
 * Пакет ревью (5.3 плана экономии) — настоящий скрипт панели над настоящим
 * временным репозиторием: ревьюер читает этот файл вместо `git diff`, значит
 * в нём должно быть всё, что дифф показал бы, и ничего, что ревью не нужно.
 */
const script = /^node "(.+)"$/.exec(reviewPackCommand())?.[1] ?? '';
const dirs: string[] = [];

function temp(): string {
  const dir = mkdtempSync(join(tmpdir(), 'review-pack-'));
  dirs.push(dir);
  return dir;
}

function git(cwd: string, ...args: string[]): void {
  const result = spawnSync(
    'git',
    ['-c', 'user.email=t@example.com', '-c', 'user.name=t', '-c', 'core.autocrlf=false', ...args],
    { cwd, encoding: 'utf8' },
  );
  if (result.status !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`);
}

function pack(cwd: string, ...args: string[]) {
  const result = spawnSync(process.execPath, [script, ...args], { cwd, encoding: 'utf8' });
  return { code: result.status, out: result.stdout, err: result.stderr };
}

/** main с тремя файлами, ветка с коммитом и незакоммиченными правками всех видов. */
function repo(): string {
  const root = temp();
  git(root, 'init', '-q', '-b', 'main');
  writeFileSync(join(root, 'old-name.txt'), 'kept line one\nkept line two\nkept line three\n');
  writeFileSync(join(root, 'service.ts'), 'export const port = 1;\n');
  writeFileSync(join(root, 'pnpm-lock.yaml'), 'lockfileVersion: 9\nLOCK_BEFORE\n');
  git(root, 'add', '.');
  git(root, 'commit', '-q', '-m', 'base');
  git(root, 'checkout', '-q', '-b', 'feature');
  writeFileSync(join(root, 'service.ts'), 'export const port = 2;\n');
  git(root, 'commit', '-q', '-am', 'COMMITTED_SUBJECT');
  writeFileSync(join(root, 'service.ts'), 'export const port = 3; // UNCOMMITTED_EDIT\n');
  git(root, 'mv', 'old-name.txt', 'new-name.txt');
  writeFileSync(join(root, 'pnpm-lock.yaml'), 'lockfileVersion: 9\nLOCK_AFTER_SECRET_BODY\n');
  writeFileSync(join(root, 'fresh.md'), 'UNTRACKED_TEXT_BODY\nsecond\n');
  writeFileSync(join(root, 'image.bin'), Buffer.from([1, 0, 2, 0, 3]));
  writeFileSync(join(root, 'plan.md'), 'PLAN_GOAL: port three\n');
  return root;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('review-pack.mjs', () => {
  it('команда панели указывает на существующий скрипт', () => {
    expect(script).toMatch(/tools[\\/]review-pack\.mjs$/);
    expect(existsSync(script)).toBe(true);
  });

  it('пакет несёт коммиты, план и дифф до рабочей копии; lock-файл без тела', () => {
    const root = repo();
    const run = pack(root, '--plan', 'plan.md');
    expect(run.code).toBe(0);
    const file = join(root, '.agent', 'tmp', 'review-pack.md');
    // Корень git отдаёт длинным путём, а tmpdir на Windows бывает коротким (`RUSYAN~1`).
    expect(run.out).toMatch(/review-pack-\w+[\\/]\.agent[\\/]tmp[\\/]review-pack\.md · /);
    expect(run.out).toMatch(/files 6 \(3 untracked\)/);
    const text = readFileSync(file, 'utf8');

    expect(text).toContain('Branch `feature`');
    expect(text).toContain('COMMITTED_SUBJECT');
    expect(text).toContain('## Plan\n\nPLAN_GOAL: port three');
    // Незакоммиченная правка видна, а промежуточное закоммиченное состояние — нет:
    // дифф идёт от общей точки до рабочей копии.
    expect(text).toContain('+export const port = 3; // UNCOMMITTED_EDIT');
    expect(text).not.toContain('+export const port = 2;');
    // Переименование — одной строкой, без тела удалённого и добавленного файла.
    expect(text).toContain('old-name.txt => new-name.txt');
    expect(text).not.toContain('-kept line one');
    // Неотслеживаемые: текст с телом, двоичный — только в списке.
    expect(text).toContain('- fresh.md +2 −0 (new, untracked)');
    expect(text).toContain('+UNTRACKED_TEXT_BODY');
    expect(text).toContain('- image.bin (binary) (new, untracked)');
    expect(text).not.toContain('b/image.bin');
    // Lock-файл назван, тело опущено.
    expect(text).toContain('- pnpm-lock.yaml +1 −1 — lockfile, diff omitted');
    expect(text).not.toContain('LOCK_AFTER_SECRET_BODY');
  });

  it('повторная сборка не включает прошлый пакет', () => {
    const root = repo();
    expect(pack(root).code).toBe(0);
    const second = pack(root);
    expect(second.code).toBe(0);
    const text = readFileSync(join(root, '.agent', 'tmp', 'review-pack.md'), 'utf8');
    expect(text).not.toContain('review-pack.md');
    expect(text.split('# Review package')).toHaveLength(2);
  });

  /** Ревью A2-F7/B2-F3: прежде имя не по-латински давало ENOENT, вложенный репозиторий — EISDIR. */
  it('неотслеживаемое имя кириллицей и вложенный репозиторий — пакет собирается', () => {
    const root = repo();
    writeFileSync(join(root, 'заметка.md'), 'CYRILLIC_BODY\n');
    const nested = join(root, 'copies', 'task');
    mkdirSync(nested, { recursive: true });
    git(nested, 'init', '-q', '-b', 'main');
    writeFileSync(join(nested, 'inner.ts'), 'INNER\n');

    const run = pack(root);

    expect(run.code).toBe(0);
    const text = readFileSync(join(root, '.agent', 'tmp', 'review-pack.md'), 'utf8');
    expect(text).toContain('- заметка.md +1 −0 (new, untracked)');
    expect(text).toContain('+CYRILLIC_BODY');
    expect(text).toContain('- copies/task/ +0 −0 (new, untracked) — nested repository');
    expect(text).not.toContain('INNER');
  });

  /** Ревью A2-F8: блок кода в правленом markdown закрывал ограду диффа; заметки агентов — не правка. */
  it('ограда диффа длиннее кавычек внутри; новые заметки .agent в пакет не идут', () => {
    const root = repo();
    writeFileSync(join(root, 'guide.md'), 'text\n```js\ncode()\n```\nAFTER_FENCE\n');
    mkdirSync(join(root, '.agent'), { recursive: true });
    writeFileSync(join(root, '.agent', 'notes.md'), 'AGENT_NOTE_BODY\n');

    expect(pack(root).code).toBe(0);
    const text = readFileSync(join(root, '.agent', 'tmp', 'review-pack.md'), 'utf8');
    const diffPart = text.slice(text.indexOf('## Diff'));
    expect(diffPart.startsWith('## Diff\n\n````diff\n')).toBe(true);
    expect(diffPart.trimEnd().endsWith('\n````')).toBe(true);
    expect(text).toContain('+AFTER_FENCE');
    expect(text).not.toContain('AGENT_NOTE_BODY');
  });

  it('--out пишет в указанный файл', () => {
    const root = repo();
    const out = join(temp(), 'nested', 'pack.md');
    expect(pack(root, '--out', out).code).toBe(0);
    expect(readFileSync(out, 'utf8')).toContain('UNCOMMITTED_EDIT');
  });

  it('не репозиторий и репозиторий без основной ветки — код 1 и причина', () => {
    const plain = temp();
    mkdirSync(join(plain, 'sub'));
    const outside = pack(join(plain, 'sub'));
    expect(outside.code).toBe(1);
    expect(outside.err).toContain('not a git repository');

    const lone = temp();
    git(lone, 'init', '-q', '-b', 'dev');
    writeFileSync(join(lone, 'a.txt'), 'a\n');
    git(lone, 'add', '.');
    git(lone, 'commit', '-q', '-m', 'only');
    const noBase = pack(lone);
    expect(noBase.code).toBe(1);
    expect(noBase.err).toContain('no base branch');
    expect(existsSync(join(lone, '.agent'))).toBe(false);
    // Явная основа снимает отказ.
    expect(pack(lone, '--base', 'dev').code).toBe(0);
  });
});
