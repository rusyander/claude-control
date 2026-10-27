import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { builtinKitDir } from '../../kit/service.ts';
import { readSieveFacts } from './sieve-facts.ts';

/**
 * Аудит g0 23.10 (!1071, F-01): сито пуша кита спросило о шести файлах «чужих −», группа
 * подтвердила их `# sieve-ack:`, а сито доставки панели спросило о тех же файлах ещё раз —
 * три хода ≈ 476k. Путь целиком и настоящий: пуш идёт через диспетчер хуков кита (как его
 * зовёт hooks.json), доставка — `readSieveFacts` панели на той же копии. Подменять нечего:
 * вопрос в том, что одно сито записало, а другое прочло.
 */

const DISPATCH = join(builtinKitDir(), 'hooks', 'lib', 'run.mjs');
// Вне системного temp, как у остальных проверок кита: temp — сама по себе зона агента.
const ROOT = join(dirname(fileURLToPath(import.meta.url)), `.push-ack-${process.pid}`);
afterAll(() => rmSync(ROOT, { recursive: true, force: true }));

const D = {
  d0: '2026-09-01T10:00:00Z',
  task: '2026-09-10T00:00:00Z',
  d3: '2026-09-12T10:00:00Z',
  d4: '2026-09-13T10:00:00Z',
  d5: '2026-09-14T10:00:00Z',
};

let n = 0;
const git = (cwd: string, args: string[], date = D.d0): string =>
  execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      GIT_AUTHOR_DATE: date,
      GIT_COMMITTER_DATE: date,
      GIT_TERMINAL_PROMPT: '0',
    },
  });
const ident = (cwd: string, who: string): void => {
  git(cwd, ['config', 'user.name', who]);
  git(cwd, ['config', 'user.email', `${who}@example.com`]);
  git(cwd, ['config', 'core.autocrlf', 'false']);
};
const save = (cwd: string, files: Record<string, string>, date: string): void => {
  for (const [file, text] of Object.entries(files)) writeFileSync(join(cwd, file), text);
  git(cwd, ['add', '-A'], date);
  git(cwd, ['commit', '-qm', 'c'], date);
};

/** Основная получила строки в двух файлах после старта; ветка переписала оба со старой копии. */
function world(): string {
  const base = join(ROOT, `w${++n}`);
  const remote = join(base, 'remote.git');
  const other = join(base, 'other');
  const work = join(base, 'work');
  mkdirSync(base, { recursive: true });
  execFileSync('git', ['-c', 'init.defaultBranch=main', 'init', '-q', '--bare', remote]);
  execFileSync('git', ['-c', 'init.defaultBranch=main', 'init', '-q', other]);
  ident(other, 'other');
  git(other, ['remote', 'add', 'origin', remote]);
  save(other, { 'f.txt': 'one\ntwo\n', 'g.txt': 'g1\ng2\n' }, D.d0);
  git(other, ['push', '-q', 'origin', 'main']);
  execFileSync('git', ['clone', '-q', remote, work]);
  ident(work, 'task');
  git(work, ['checkout', '-qb', 'feat']);
  save(other, { 'f.txt': 'one\ntwo\nforeign\n', 'g.txt': 'g1\ng2\nforeignG\nforeignG2\n' }, D.d3);
  git(other, ['push', '-q', 'origin', 'main']);
  git(work, ['fetch', '-q', 'origin'], D.d4);
  git(work, ['rebase', '-q', 'origin/main'], D.d4);
  save(work, { 'f.txt': 'one\ntwo\nmine\n', 'g.txt': 'g1\ng2\nforeignG2\n' }, D.d4);
  return work;
}

/** Причина отказа PreToolUse кита; пусто — пуш пропущен. */
function kitPush(work: string, command: string): string {
  const transcript = join(ROOT, `t${++n}.jsonl`);
  writeFileSync(
    transcript,
    `${JSON.stringify({ type: 'user', message: { role: 'user', content: 'запушь' }, timestamp: D.task })}\n`,
  );
  const out = spawnSync(process.execPath, [DISPATCH, 'pre'], {
    input: JSON.stringify({
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      tool_input: { command },
      transcript_path: transcript,
      session_id: 'push-ack',
      cwd: work,
    }),
    encoding: 'utf8',
    env: {
      ...process.env,
      AGENTDECK_KIT_VARIANT: '',
      AGENTDECK_HEAVY_QUEUE_DIR: '',
      AGENTDECK_KIT_STATE: join(ROOT, 'state'),
    },
    timeout: 30_000,
  });
  const text = out.stdout.trim();
  const hook = text
    ? (JSON.parse(text) as { hookSpecificOutput?: { permissionDecisionReason?: string } })
    : {};
  return hook.hookSpecificOutput?.permissionDecisionReason ?? '';
}

describe('сито доставки берёт подтверждение пуша (F-01)', () => {
  it('файлы, подтверждённые пушем, доставка не спрашивает снова; новые строки — спрашивает', async () => {
    const work = world();
    mkdirSync(ROOT, { recursive: true });
    expect(kitPush(work, 'git push origin feat')).toMatch(/push-sieves\(foreign-removal\)/);
    expect(kitPush(work, '# sieve-ack: f.txt g.txt\ngit push origin feat')).toBe('');
    const acks = JSON.parse(
      readFileSync(join(work, '.agent', 'tmp', 'sieve-acks.json'), 'utf8'),
    ) as Record<string, unknown>;
    expect(acks.feat).toEqual(['f.txt', 'g.txt']);
    const prints = acks['~removed'] as Record<string, Record<string, string>>;
    expect(Object.keys(prints.feat ?? {})).toEqual(['f.txt', 'g.txt']);

    const acked = await readSieveFacts({ cwd: work, startedAt: D.task });
    expect(acked.mechanics.foreignRemovals).toBeUndefined();
    expect(acked.mechanics.foreignAcked).toEqual(['f.txt', 'g.txt']);

    // Ветка сняла ещё одну чужую строку в g.txt — её пуш не подтверждал.
    save(work, { 'g.txt': 'g1\ng2\n' }, D.d5);
    const moved = await readSieveFacts({ cwd: work, startedAt: D.task });
    expect(moved.mechanics.foreignRemovals).toEqual(['g.txt']);
    expect(Object.keys(moved.mechanics.foreignBlame ?? {})).toEqual(['g.txt']);
    expect(moved.mechanics.foreignAcked).toEqual(['f.txt']);
  });

  it('подтверждение без отпечатка (старый кит) и чужой ветки — не в счёт', async () => {
    const work = world();
    mkdirSync(join(work, '.agent', 'tmp'), { recursive: true });
    writeFileSync(
      join(work, '.agent', 'tmp', 'sieve-acks.json'),
      JSON.stringify({ feat: ['f.txt', 'g.txt'], '~removed': { other: { 'f.txt': 'x' } } }),
    );
    const facts = await readSieveFacts({ cwd: work, startedAt: D.task });
    expect(facts.mechanics.foreignRemovals).toEqual(['f.txt', 'g.txt']);
    expect(facts.mechanics.foreignAcked).toBeUndefined();
  });

  it('в строке «чужих −» все диапазоны строк файла, без «…»', async () => {
    const work = world();
    // Пять разнесённых чужих строк в одном файле.
    const base = join(work, '..', 'other');
    save(base, { 'h.txt': 'a\nb\nc\nd\ne\nf\ng\nh\ni\nj\n' }, D.d0);
    git(base, ['push', '-q', 'origin', 'main']);
    save(base, { 'h.txt': 'a\nX1\nb\nc\nX2\nd\ne\nX3\nf\ng\nX4\nh\ni\nX5\nj\n' }, D.d3);
    git(base, ['push', '-q', 'origin', 'main']);
    git(work, ['fetch', '-q', 'origin'], D.d4);
    git(work, ['rebase', '-q', 'origin/main'], D.d4);
    save(work, { 'h.txt': 'a\nb\nc\nd\ne\nf\ng\nh\ni\nj\n' }, D.d5);
    const facts = await readSieveFacts({ cwd: work, startedAt: D.task });
    expect(facts.mechanics.foreignBlame?.['h.txt']).toMatch(/lines 2, 5, 8, 11, 14$/);
  });
});
