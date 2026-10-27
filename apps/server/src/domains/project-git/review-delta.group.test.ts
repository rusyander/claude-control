import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { ChatLink } from '../../lib/app-store/app-store.types.ts';
import { planCascadeStage } from '../chat/ChatCascadeStages/ChatCascadeStages.ts';
import { readHeadSha } from './read.ts';
import { readReviewDelta } from './review-delta.ts';

/**
 * Ревью группы — только то, что сделала ЭТА группа (владелец, Telegram 26.10, замечание 4):
 * группа разделения, заведённая на MR, уже прошедший ревью в другом чате, только слила
 * основную с конфликтом — а ревью читало ветку целиком против основной, 54 файла и
 * 30–40 минут лишнего. Мерило — коммит, с которого группа началась (`ChatLink.startSha`).
 * Всё на настоящем git: удалённый, ветка MR, опубликованная ДО группы, движение основной.
 */
describe('readReviewDelta с коммитом начала группы', () => {
  let root: string;
  let work: string;
  let start: string;

  const git = (cwd: string, ...args: string[]): string =>
    execFileSync(
      'git',
      ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'core.autocrlf=false', ...args],
      { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    );
  const commit = (file: string, text: string, message: string): void => {
    writeFileSync(join(work, file), text);
    git(work, 'add', file);
    git(work, 'commit', '-q', '-m', message);
  };
  /** Основная уходит вперёд: коммит другого человека прямо в удалённый main. */
  const mainMoves = (file: string, text: string): void => {
    const other = join(root, 'other');
    git(root, 'clone', '-q', join(root, 'remote.git'), other);
    writeFileSync(join(other, file), text);
    git(other, 'add', file);
    git(other, 'commit', '-q', '-m', `main: ${file}`);
    git(other, 'push', '-q', 'origin', 'main');
    rmSync(other, { recursive: true, force: true });
    git(work, 'fetch', '-q', 'origin');
  };
  /** Слияние основной с конфликтом в shared.txt и его разрешение группой. */
  const conflictMerge = (): void => {
    mainMoves('shared.txt', 'line from main\n');
    try {
      git(work, 'merge', '-q', '--no-edit', 'origin/main');
    } catch {
      // Конфликт — ожидаемо: его и разрешает группа.
    }
    writeFileSync(join(work, 'shared.txt'), 'line from mr + line from main\n');
    git(work, 'add', 'shared.txt');
    git(work, 'commit', '-q', '--no-edit');
  };

  /** Связь группы так, как её пишет запуск разделения (`linkRecord`) — с коммитом начала. */
  const groupLink = (patch: Partial<ChatLink> = {}): ChatLink => ({
    parentChatId: 'parent',
    createdAt: '2026-10-26T10:00:00.000Z',
    branch: 'feature/mr',
    groupIndex: 1,
    stage: 'work',
    model: 'claude-opus-5-5',
    effort: 'high',
    lowered: false,
    ceilingModel: 'claude-opus-5-5',
    ceilingEffort: 'high',
    startSha: start,
    ...patch,
  });
  const stage = (link: ChatLink, deliver = false) =>
    planCascadeStage({
      link,
      ok: true,
      text: 'конфликт с main разрешён, коммит слияния готов',
      task: 'Разреши конфликт MR с основной веткой',
      hasWork: () => true,
      reviewDelta: () => readReviewDelta(work, undefined, link.startSha),
      ...(deliver ? { deliver: true } : {}),
    });

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'cc-review-group-'));
    work = join(root, 'work');
    git(root, 'init', '-q', '--bare', '-b', 'main', 'remote.git');
    git(root, 'clone', '-q', join(root, 'remote.git'), work);
    commit('shared.txt', 'base\n', 'base');
    git(work, 'push', '-q', 'origin', 'main');
    git(work, 'remote', 'set-head', 'origin', 'main');
    git(work, 'checkout', '-q', '-b', 'feature/mr');
    // MR, отревьюенный в другом чате до группы: два коммита, ветка на удалённом.
    commit('shared.txt', 'line from mr\n', 'mr: shared');
    commit('feature.txt', 'feature\n', 'mr: feature');
    git(work, 'push', '-q', '-u', 'origin', 'feature/mr');
    // Группа заведена здесь: её начало — голова копии в этот момент.
    start = readHeadSha(work) ?? '';
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('голова копии читается коммитом начала; вне репозитория — нет', () => {
    expect(start).toMatch(/^[0-9a-f]{40}$/);
    expect(start).toBe(git(work, 'rev-parse', 'HEAD').trim());
    expect(readHeadSha(root)).toBeUndefined();
  });

  it('задача «только конфликт»: в охвате один коммит слияния, и он с разрешением конфликта', () => {
    conflictMerge();
    const delta = readReviewDelta(work, undefined, start);
    expect(delta).toMatchObject({ kind: 'commits', from: start.slice(0, 12), dirty: false });
    if (delta.kind !== 'commits') return;
    expect(delta.commits).toHaveLength(1);
    expect(delta.commits[0]).toMatchObject({ type: 'merge' });
    // Коммиты MR до группы в охват не попали.
    expect(delta.commits.map((entry) => entry.subject).join('\n')).not.toContain('mr: ');
    // Команда задания показывает ТОЛЬКО разрешение конфликта, без пришедшего с основной.
    const shown = git(work, 'show', '--remerge-diff', '--format=', delta.commits[0]?.sha ?? '');
    expect(shown).toContain('line from mr + line from main');
    expect(shown).not.toContain('feature.txt');
  });

  // Конфликт, решённый целиком своей стороной: итог совпадает с родителем, и `git show`
  // (комбинированный diff) молчит. Разрешение всё равно работа группы — видит его только
  // `--remerge-diff`, и ревью такое слияние не пропускает.
  it('конфликт решён целиком своей стороной — слияние всё равно в охвате ревью', () => {
    mainMoves('shared.txt', 'line from main\n');
    try {
      git(work, 'merge', '-q', '--no-edit', 'origin/main');
    } catch {
      // Конфликт — ожидаемо.
    }
    git(work, 'checkout', '--ours', 'shared.txt');
    git(work, 'add', 'shared.txt');
    git(work, 'commit', '-q', '--no-edit');
    const delta = readReviewDelta(work, undefined, start);
    expect(delta).toMatchObject({ kind: 'commits' });
    if (delta.kind !== 'commits') return;
    expect(delta.commits.map((entry) => entry.type)).toEqual(['merge']);
  });

  it('планировщик: ревью конфликтного слияния — охват от коммита начала, а не вся ветка', () => {
    conflictMerge();
    const staged = stage(groupLink());
    expect(staged?.stage).toBe('review');
    const prompt = staged?.prompt ?? '';
    expect(prompt).not.toContain('once and in full');
    expect(prompt).toContain(`started at commit ${start.slice(0, 12)}`);
    expect(prompt).toContain('--remerge-diff');
    expect(prompt).toMatch(/git log --first-parent .*[0-9a-f]{12}\.\.HEAD/);
    expect(prompt).not.toContain('mr: feature');
    // Найденное вне охвата — отдельным списком, правкам оно не уходит.
    expect(prompt).toContain('"preExisting"');
    // Коммит начала едет по связи звена дальше — правкам и доставке.
    expect(staged?.link.startSha).toBe(start);
  });

  it('новая работа на готовом MR: в охвате только новые коммиты', () => {
    commit('fix.txt', 'fix\n', 'group: fix');
    commit('fix2.txt', 'fix2\n', 'group: fix two');
    const delta = readReviewDelta(work, undefined, start);
    expect(delta.kind).toBe('commits');
    if (delta.kind !== 'commits') return;
    expect(delta.commits.map((entry) => [entry.type, entry.subject])).toEqual([
      ['commit', 'group: fix two'],
      ['commit', 'group: fix'],
    ]);
    const prompt = stage(groupLink())?.prompt ?? '';
    expect(prompt).toContain(`git diff ${start.slice(0, 12)}..HEAD`);
    expect(prompt).toContain('group: fix two');
  });

  it('слияние без конфликтов — своего у группы нет: ревью не заводится, доставка с причиной', () => {
    mainMoves('other.txt', 'other\n');
    git(work, 'merge', '-q', '--no-edit', 'origin/main');
    expect(readReviewDelta(work, undefined, start)).toEqual({
      kind: 'none',
      from: start.slice(0, 12),
      published: false,
      group: true,
    });
    const delivered = stage(groupLink(), true);
    expect(delivered?.stage).toBe('deliver');
    expect(delivered?.prompt).toContain('the panel skipped its review');
    expect(delivered?.prompt).toContain(start.slice(0, 12));
    expect(stage(groupLink())).toBeUndefined();
    // Голова уже на удалённом — и доставлять нечего.
    git(work, 'push', '-q', 'origin', 'feature/mr');
    expect(readReviewDelta(work, undefined, start)).toMatchObject({
      kind: 'none',
      published: true,
    });
    expect(stage(groupLink(), true)).toBeUndefined();
  });

  it('ни коммита с начала и копия чистая — ревью нечего; незакоммиченное — в охвате', () => {
    expect(readReviewDelta(work, undefined, start)).toMatchObject({ kind: 'none', group: true });
    writeFileSync(join(work, 'feature.txt'), 'feature dirty\n');
    const delta = readReviewDelta(work, undefined, start);
    expect(delta).toMatchObject({ kind: 'commits', commits: [], dirty: true });
    expect(stage(groupLink())?.prompt).toContain('git diff HEAD');
  });

  it('rebase после начала: коммит начала не предок головы — range-diff от него', () => {
    mainMoves('other.txt', 'other\n');
    git(work, 'rebase', '-q', 'origin/main');
    expect(readReviewDelta(work, undefined, start)).toMatchObject({ kind: 'none', group: true });
    commit('fix.txt', 'fix\n', 'group: after rebase');
    const delta = readReviewDelta(work, undefined, start);
    expect(delta).toMatchObject({ kind: 'delta', group: true });
    if (delta.kind !== 'delta') return;
    expect(delta.changes).toHaveLength(1);
    expect(delta.changes[0]).toMatch(/> 3:\s+[0-9a-f]+ group: after rebase$/);
    expect(stage(groupLink())?.prompt).toContain(`started at commit ${start.slice(0, 12)}`);
  });

  it('связь без коммита начала или с неизвестным — прежний путь', () => {
    commit('fix.txt', 'fix\n', 'group: fix');
    expect(readReviewDelta(work, undefined, undefined)).toEqual({ kind: 'whole' });
    expect(readReviewDelta(work, undefined, 'f'.repeat(40))).toEqual({ kind: 'whole' });
    expect(stage(groupLink({ startSha: undefined }))?.prompt).toContain('once and in full');
  });
});
