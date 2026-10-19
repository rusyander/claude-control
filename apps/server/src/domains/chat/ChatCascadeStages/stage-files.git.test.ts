import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { hasWorkSince } from '../../project-git/read.ts';
import { groupPlanPath, readStageArtifacts, writeGroupPlanFile } from './stage-files.ts';

/**
 * Файловая половина контекста звена на настоящем git и настоящих каталогах:
 * план группы файлом (L2.1) и артефакты прошлых звеньев (L7.4). Главное здесь —
 * чего НЕ случается: файл плана не становится «работой группы» и не пишется
 * туда, где его увидел бы `git status`; перенесённое из основного каталога за
 * артефакт группы не выдаётся.
 */

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function put(dir: string, path: string, body = 'x', at?: Date): void {
  mkdirSync(dirname(join(dir, path)), { recursive: true });
  writeFileSync(join(dir, path), body);
  if (at) utimesSync(join(dir, path), at, at);
}

const PLAN = '## 1. Анализ\nтекст\n## 5. Критерии приёмки\n- А';

describe('план группы файлом в копии (L2.1)', () => {
  let repo: string;

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), 'stage-plan-'));
    git(repo, 'init', '-q');
    put(repo, 'a.txt', 'a');
    git(repo, 'add', '.');
    git(repo, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'init');
  });
  afterEach(() => rmSync(repo, { recursive: true, force: true }));

  it('пишет план туда, где git его игнорирует, и это не работа группы', () => {
    put(repo, '.git/info/exclude', '.agent/\n');
    const rel = writeGroupPlanFile(repo, PLAN);
    expect(rel).toBe(groupPlanPath(PLAN));
    expect(rel).toMatch(/^\.agent\/plans\/group-plan-[0-9a-f]{12}\.agent\.md$/);
    expect(readFileSync(join(repo, rel!), 'utf8')).toBe(`${PLAN}\n`);
    expect(git(repo, 'status', '--porcelain')).toBe('');
    expect(hasWorkSince(repo)).toBe(false);
    // Повтор того же плана — тот же путь, файл не переписывается.
    expect(writeGroupPlanFile(repo, PLAN)).toBe(rel);
    // Другой план — другой файл: ссылка звена на прежний не ломается.
    expect(writeGroupPlanFile(repo, `${PLAN}\n- Б`)).not.toBe(rel);
  });

  it('путь не игнорируется или это не репозиторий — файла нет, звено получит план целиком', () => {
    expect(writeGroupPlanFile(repo, PLAN)).toBeUndefined();
    expect(existsSync(join(repo, '.agent'))).toBe(false);
    const plain = mkdtempSync(join(tmpdir(), 'stage-plan-plain-'));
    try {
      expect(writeGroupPlanFile(plain, PLAN)).toBeUndefined();
    } finally {
      rmSync(plain, { recursive: true, force: true });
    }
  });
});

describe('артефакты прошлых звеньев (L7.4)', () => {
  let main: string;
  let copy: string;
  const old = new Date('2026-10-01T00:00:00Z');

  beforeEach(() => {
    main = mkdtempSync(join(tmpdir(), 'stage-art-'));
    git(main, 'init', '-q');
    put(main, 'a.txt', 'a');
    git(main, 'add', '.');
    git(main, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'init');
    copy = join(main, '..', `${main.split(/[\\/]/).pop()}-copy`);
    git(main, 'worktree', 'add', '-q', '-b', 'group', copy);
  });
  afterEach(() => {
    rmSync(copy, { recursive: true, force: true });
    rmSync(main, { recursive: true, force: true });
  });

  it('берёт новое в копии, перенесённое из основного каталога (старое время) — нет', () => {
    // Перенос локального слоя сохраняет время изменения (`mirror-local.ts`).
    put(copy, '.agent/tickets/OLD-1.agent.md', 'old', old);
    put(copy, '.agent/tests/runs/20261001-old.run.json', '{}', old);
    put(copy, '.agent/tickets/PROJ-7.agent.md');
    put(copy, '.agent/tickets/PROJ-7.sessions.json');
    put(copy, '.agent/tests/runs/20261019-a.run.json', '{}');
    put(copy, '.agent/tmp/gates.log');
    put(copy, '.agent/tmp/notes.txt');
    put(copy, 'e2e/screenshots/before-after/proj-7/before/a.png');
    put(copy, '.agent/screenshots/before-after/proj-7/after/a.png');

    const found = readStageArtifacts(copy);
    expect(found).toEqual(
      expect.arrayContaining([
        '.agent/screenshots/before-after/proj-7/',
        'e2e/screenshots/before-after/proj-7/',
        '.agent/tickets/PROJ-7.agent.md',
        '.agent/tests/runs/20261019-a.run.json',
        '.agent/tmp/gates.log',
      ]),
    );
    expect(found).toHaveLength(5);
  });

  it('не больше десяти путей, самые новые в каждом месте первыми', () => {
    for (let index = 0; index < 8; index += 1) {
      const at = new Date(Date.now() + index * 1000);
      put(copy, `.agent/tmp/gate-${index}.log`, 'x', at);
      put(copy, `.agent/tickets/T-${index}.agent.md`, 'x', at);
      put(copy, `.agent/tests/runs/r-${index}.run.json`, '{}', at);
      put(copy, `e2e/screenshots/before-after/t-${index}/a.png`, 'x', at);
    }
    const found = readStageArtifacts(copy);
    expect(found.length).toBe(10);
    expect(found[0]).toBe('e2e/screenshots/before-after/t-7/');
    expect(found).toContain('.agent/tickets/T-7.agent.md');
    expect(found).not.toContain('.agent/tickets/T-0.agent.md');
  });

  it('общий каталог без отметки копии: только новее переданного времени, иначе ничего', () => {
    put(main, '.agent/tickets/OLD-1.agent.md', 'old', old);
    expect(readStageArtifacts(main)).toEqual([]);
    put(main, '.agent/tmp/gates.log');
    expect(readStageArtifacts(main, '2026-10-02T00:00:00Z')).toEqual(['.agent/tmp/gates.log']);
  });
});
