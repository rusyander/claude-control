import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { ChatLink } from '../../lib/app-store/app-store.types.ts';
import { planCascadeStage } from '../chat/ChatCascadeStages/ChatCascadeStages.ts';
import { hasWorkSince } from './read.ts';
import { parseRangeDiff, readReviewDelta } from './review-delta.ts';

/**
 * Журнал 19.10 02:19 (L7.13): группа «Control Plane» с MR на ревью в новой
 * сессии только перенесла ветку на свежую основную и запушила её арендой — и
 * панель завела ревью всего MR заново. Здесь та же последовательность на
 * настоящем git: удалённый репозиторий, ветка группы, опубликованная ДО начала
 * звена, движение основной, rebase, push. Время каждого шага задано
 * (`GIT_COMMITTER_DATE` пишет и журнал ссылок), так что «начало звена» — точка
 * между шагами, а не гонка с часами.
 */
describe('readReviewDelta: что работа изменила против опубликованной ветки', () => {
  let root: string;
  let work: string;
  const B_LINES = ['b1', 'b2', 'b3', 'b4', 'b5', 'b6', 'b7', 'b8', ''];
  const at = (minute: number): string => `2026-10-18T20:${String(minute).padStart(2, '0')}:00Z`;

  const git = (cwd: string, minute: number, ...args: string[]): string =>
    execFileSync(
      'git',
      ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'core.autocrlf=false', ...args],
      {
        cwd,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, GIT_COMMITTER_DATE: at(minute), GIT_AUTHOR_DATE: at(minute) },
      },
    );
  const commit = (minute: number, file: string, text: string, message: string): void => {
    writeFileSync(join(work, file), text);
    git(work, minute, 'add', file);
    git(work, minute, 'commit', '-q', '-m', message);
  };
  /** Основная уходит вперёд: коммит другого человека прямо в удалённый main. */
  const mainMoves = (minute: number): void => {
    const other = join(root, 'other');
    git(root, minute, 'clone', '-q', join(root, 'remote.git'), other);
    writeFileSync(join(other, 'main.txt'), `main at ${minute}\n`);
    git(other, minute, 'add', 'main.txt');
    git(other, minute, 'commit', '-q', '-m', 'main moves');
    git(other, minute, 'push', '-q', 'origin', 'main');
    rmSync(other, { recursive: true, force: true });
    git(work, minute, 'fetch', '-q', 'origin');
  };

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'cc-review-delta-'));
    work = join(root, 'work');
    git(root, 0, 'init', '-q', '--bare', '-b', 'main', 'remote.git');
    git(root, 0, 'clone', '-q', join(root, 'remote.git'), work);
    commit(1, 'base.txt', 'base\n', 'base');
    git(work, 1, 'push', '-q', 'origin', 'main');
    git(work, 1, 'remote', 'set-head', 'origin', 'main');
    git(work, 2, 'checkout', '-q', '-b', 'feature/cp');
    commit(3, 'a.txt', 'a\n', 'group: a');
    commit(4, 'b.txt', B_LINES.join('\n'), 'group: b');
    // MR группы: ветка на удалённом в 20:05, звено начнётся в 20:10.
    git(work, 5, 'push', '-q', '-u', 'origin', 'feature/cp');
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('пустой rebase с пушем — патчи те же и голова на удалённом', () => {
    mainMoves(12);
    git(work, 13, 'rebase', '-q', 'origin/main');
    expect(readReviewDelta(work, at(10))).toEqual({
      kind: 'none',
      from: expect.stringMatching(/^[0-9a-f]{12}$/),
      published: false,
    });
    git(work, 14, 'push', '-q', '--force-with-lease', 'origin', 'feature/cp');
    expect(readReviewDelta(work, at(10))).toMatchObject({ kind: 'none', published: true });
  });

  it('новый коммит после rebase — дельта из него одного, и команда её показывает', () => {
    mainMoves(12);
    git(work, 13, 'rebase', '-q', 'origin/main');
    commit(15, 'c.txt', 'c\n', 'group: c');
    const delta = readReviewDelta(work, at(10));
    expect(delta.kind).toBe('delta');
    if (delta.kind !== 'delta') return;
    expect(delta.changes).toHaveLength(1);
    expect(delta.changes[0]).toMatch(/^-:\s+-+ > 3:\s+[0-9a-f]+ group: c$/);
    expect(delta.command).toMatch(
      /^git range-diff [0-9a-f]{12}\.\.[0-9a-f]{12} [0-9a-f]{12}\.\.HEAD$/,
    );
    // Команда из задания ревью работает в копии и показывает ту же дельту.
    const shown = git(work, 16, ...delta.command.split(' ').slice(1));
    expect(parseRangeDiff(shown)?.map((pair) => pair.mark)).toEqual(['=', '=', '>']);
  });

  it('изменённый патч — дельта со знаком «!»', () => {
    // Одна строка из восьми: патч тот же коммит, но другой — range-diff ставит «!».
    writeFileSync(join(work, 'b.txt'), [...B_LINES.slice(0, -2), 'b changed', ''].join('\n'));
    git(work, 15, 'commit', '-q', '-a', '--amend', '--no-edit');
    const delta = readReviewDelta(work, at(10));
    expect(delta.kind).toBe('delta');
    if (delta.kind === 'delta') expect(delta.changes[0]).toMatch(/ ! 2:\s+[0-9a-f]+ group: b$/);
  });

  it('ветки на удалённом до начала звена не было — ревью всей работы', () => {
    // Звено началось в 20:04, push был в 20:05: опубликованного начала нет. Git
    // на `ref@{20:04}` отдал бы самую старую запись — то есть запушенную.
    mainMoves(12);
    git(work, 13, 'rebase', '-q', 'origin/main');
    expect(readReviewDelta(work, at(4))).toEqual({ kind: 'whole' });
  });

  it('незакоммиченное — работа, которой range-diff не видит: ревью всей работы', () => {
    mainMoves(12);
    git(work, 13, 'rebase', '-q', 'origin/main');
    writeFileSync(join(work, 'a.txt'), 'a dirty\n');
    expect(readReviewDelta(work, at(10))).toEqual({ kind: 'whole' });
  });

  it('звено начато не с опубликованного: локальный коммит до начала, не запушенный', () => {
    commit(8, 'local.txt', 'local\n', 'group: local');
    mainMoves(12);
    git(work, 13, 'rebase', '-q', 'origin/main');
    expect(readReviewDelta(work, at(10))).toEqual({ kind: 'whole' });
  });

  it('без начала звена и вне репозитория — ревью всей работы', () => {
    expect(readReviewDelta(work, undefined)).toEqual({ kind: 'whole' });
    expect(readReviewDelta(root, at(10))).toEqual({ kind: 'whole' });
  });

  /**
   * Путь инцидента целиком: `hasWorkSince` после rebase видит «работу» (даты
   * коммитов новые), и без дельты планировщик заводит ревью. С дельтой из того
   * же репозитория — цепочка закрыта: читать нечего, доставлять нечего.
   */
  it('планировщик: пустой rebase доставленной ветки ревью не заводит', () => {
    mainMoves(12);
    git(work, 13, 'rebase', '-q', 'origin/main');
    git(work, 14, 'push', '-q', '--force-with-lease', 'origin', 'feature/cp');
    const link: ChatLink = {
      parentChatId: 'parent',
      createdAt: at(10),
      branch: 'feature/cp',
      groupIndex: 6,
      stage: 'work',
      model: 'claude-opus-5-5',
      effort: 'high',
      lowered: false,
      ceilingModel: 'claude-opus-5-5',
      ceilingEffort: 'high',
    };
    const input = {
      link,
      ok: true,
      text: 'rebase на свежий main, push --force-with-lease',
      task: 'задача группы',
      hasWork: () => hasWorkSince(work, link.createdAt),
      deliver: true,
    };
    expect(input.hasWork()).toBe(true);
    expect(planCascadeStage(input)?.stage).toBe('review');
    expect(
      planCascadeStage({ ...input, reviewDelta: () => readReviewDelta(work, link.createdAt) }),
    ).toBeUndefined();

    commit(15, 'c.txt', 'c\n', 'group: c');
    const staged = planCascadeStage({
      ...input,
      reviewDelta: () => readReviewDelta(work, link.createdAt),
    });
    expect(staged?.stage).toBe('review');
    expect(staged?.prompt).toContain('Review ONLY what changed since');
    expect(staged?.prompt).toMatch(/- -:\s+-+ > 3:\s+[0-9a-f]+ group: c/);
  });
});
