import { describe, it, expect, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ProjectTestRunRecord } from '@agentdeck/contracts';
import { readRun, writeRun } from '../runs-store/runs-store.ts';
import { forget, recall, rememberGreen, replayRun, treeFingerprint } from './check-memo.ts';

/**
 * Отпечаток дерева (9.3) на настоящем git: ответ из памяти честен ровно
 * настолько, насколько отпечаток замечает любую перемену в коде.
 */
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]): void {
  const out = spawnSync('git', ['-c', 'user.email=x@y', '-c', 'user.name=x', ...args], { cwd });
  if (out.status !== 0) throw new Error(`git ${args.join(' ')}: ${out.stderr}`);
}

function repo(): string {
  const root = mkdtempSync(join(tmpdir(), 'check-memo-'));
  roots.push(root);
  git(root, 'init', '-q', '-b', 'main');
  writeFileSync(join(root, 'a.ts'), 'export const a = 1;\n');
  writeFileSync(join(root, '.gitignore'), 'dist/\n');
  git(root, 'add', '.');
  git(root, 'commit', '-qm', 'init');
  return root;
}

describe('отпечаток дерева', () => {
  it('то же дерево — тот же отпечаток', () => {
    const root = repo();
    expect(treeFingerprint(root)).toBe(treeFingerprint(root));
  });

  it('меняется от правки, новой строки в индексе, нового файла и коммита', () => {
    const root = repo();
    const seen = new Set([treeFingerprint(root)]);

    writeFileSync(join(root, 'a.ts'), 'export const a = 2;\n');
    seen.add(treeFingerprint(root));
    git(root, 'add', 'a.ts');
    writeFileSync(join(root, 'a.ts'), 'export const a = 3;\n');
    seen.add(treeFingerprint(root));
    writeFileSync(join(root, 'b.ts'), 'export const b = 1;\n');
    seen.add(treeFingerprint(root));
    writeFileSync(join(root, 'b.ts'), 'export const b = 2;\n');
    seen.add(treeFingerprint(root));
    git(root, 'add', '.');
    git(root, 'commit', '-qm', 'two');
    seen.add(treeFingerprint(root));

    expect(seen.size).toBe(6);
  });

  it('заметки .agent и игнорируемое git не меняют отпечаток: прогон сам пишет историю', () => {
    const root = repo();
    // Хранилище кейсов бывает и в git: запись истории правит отслеживаемый файл.
    mkdirSync(join(root, '.agent', 'tests'), { recursive: true });
    writeFileSync(join(root, '.agent', 'tests', 'group.tests.json'), '{}');
    git(root, 'add', '.');
    git(root, 'commit', '-qm', 'store');
    const before = treeFingerprint(root);
    writeFileSync(join(root, '.agent', 'tests', 'group.tests.json'), '{"status":"passed"}');
    writeFileSync(join(root, '.agent', 'tests', 'run.json'), '{}');
    mkdirSync(join(root, 'dist'));
    writeFileSync(join(root, 'dist', 'a.js'), '1');

    expect(treeFingerprint(root)).toBe(before);
  });

  /** Ревью B2-F2: git отдаёт вложенный репозиторий строкой `dir/` — прежде EISDIR ронял прогон. */
  it('вложенный неотслеживаемый репозиторий — отпечатка нет, без падения', () => {
    const root = repo();
    const nested = join(root, 'worktrees', 'task');
    mkdirSync(nested, { recursive: true });
    git(nested, 'init', '-q');
    writeFileSync(join(nested, 'x.ts'), '1');
    expect(treeFingerprint(root)).toBeUndefined();
  });

  /** Ревью B2-F5: проект-подкаталог собирает соседние пакеты; фильтр показа не прячет правку. */
  it('проект-подкаталог видит правку соседнего пакета; textconv не прячет правку', () => {
    const root = repo();
    mkdirSync(join(root, 'app'));
    mkdirSync(join(root, 'shared'));
    writeFileSync(join(root, 'app', 'main.ts'), 'import "../shared/x";\n');
    writeFileSync(join(root, 'shared', 'x.ts'), 'export const x = 1;\n');
    writeFileSync(join(root, 'shared', 'data.bin'), 'v1');
    writeFileSync(join(root, '.gitattributes'), '*.bin diff=same\n');
    git(root, 'add', '.');
    git(root, 'commit', '-qm', 'pkgs');
    git(root, 'config', 'diff.same.textconv', 'true');
    const project = join(root, 'app');
    const seen = new Set([treeFingerprint(project)]);

    writeFileSync(join(root, 'shared', 'x.ts'), 'export const x = 2;\n');
    seen.add(treeFingerprint(project));
    writeFileSync(join(root, 'shared', 'data.bin'), 'v2');
    seen.add(treeFingerprint(project));

    expect(seen.size).toBe(3);
  });

  it('не репозиторий — отпечатка нет, и памяти нет', () => {
    const root = mkdtempSync(join(tmpdir(), 'check-memo-plain-'));
    roots.push(root);
    expect(treeFingerprint(root)).toBeUndefined();
  });
});

describe('память зелёных прогонов', () => {
  it('отвечает только той же команде на том же отпечатке; не зелёный снимает запись', () => {
    const root = repo();
    rememberGreen(root, { key: 'k1', fingerprint: 'f1', runId: 'r1', at: 't' });

    expect(recall(root, 'k1', 'f1')?.runId).toBe('r1');
    expect(recall(root, 'k1', 'f2')).toBeUndefined();
    expect(recall(root, 'k2', 'f1')).toBeUndefined();

    forget(root, 'k1');
    expect(recall(root, 'k1', 'f1')).toBeUndefined();
  });

  it('ответ памяти — новая запись истории с той же сводкой; исходной нет — ответа нет', () => {
    const root = repo();
    const source: ProjectTestRunRecord = {
      id: 'r1',
      mode: 'import',
      actor: 'ci',
      status: 'passed',
      startedAt: '2026-10-17T10:00:00.000Z',
      finishedAt: '2026-10-17T10:01:00.000Z',
      scope: 'tests-cli run: node run.mjs',
      tms: { kind: 'xray', runId: 'R9' },
      results: [],
      summary: { total: 1, passed: 1, failed: 0, blocked: 0, skipped: 0, unknown: 0 },
    } as unknown as ProjectTestRunRecord;
    writeRun(root, source);
    expect(readRun(root, 'r1')?.tms?.runId).toBe('R9');

    const replay = replayRun(root, 'r1', 'из памяти r1', new Date('2026-10-17T12:00:00.000Z'));

    expect(replay?.id).not.toBe('r1');
    expect(replay?.startedAt).toBe('2026-10-17T12:00:00.000Z');
    expect(replay?.scope).toBe('из памяти r1');
    expect(replay?.summary).toEqual(source.summary);
    // Отправка в тест-менеджмент — у исходного прогона, копия её не наследует.
    expect(replay?.tms).toBeUndefined();
    expect(readRun(root, replay?.id ?? '')?.scope).toBe('из памяти r1');
    expect(replayRun(root, 'нет-такого', 'x')).toBeUndefined();
  });
});
