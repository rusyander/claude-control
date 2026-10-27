import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { builtinKitDir } from './service.ts';

/**
 * Аудит g0 26.10, F4: три правила пришли туда, где неприменимы, и один карточный запрет — на
 * разрешении конфликта. Через настоящий диспетчер `run.mjs`, как его зовёт hooks.json:
 *   1. триггер тест-файла пропускает черновики (`.agent/tmp/resolve-spec.mjs` — скрипт слияния);
 *   2. во время rebase/merge (MERGE_HEAD, rebase-merge; у worktree — в его собственном git-каталоге)
 *      visible-fix-shots едет контекстом, карточка не отказывает; вне слияния тот же вызов — отказ;
 *   3. doc-classification не шлётся на правку УЖЕ лежащей страницы в дереве `content/` сайта
 *      документации; новая страница там правило получает.
 */

const KIT = builtinKitDir();
const DISPATCH = join(KIT, 'hooks', 'lib', 'run.mjs');
const dir = mkdtempSync(join(tmpdir(), 'kit-g0-misfire-'));
const STATE = join(dir, 'state');
// Копии вне временного каталога: правка во временном — черновик.
const base = mkdtempSync(join(process.cwd(), 'node_modules', '.kit-g0-misfire-'));
const copy = join(base, 'copy');
const wt = join(base, 'wt');
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
  rmSync(base, { recursive: true, force: true });
});

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
mkdirSync(join(copy, 'src'), { recursive: true });
mkdirSync(join(copy, 'content', 'ru'), { recursive: true });
git(copy, '-c', 'init.defaultBranch=main', 'init', '-q');
git(copy, 'config', 'user.name', 't');
git(copy, 'config', 'user.email', 't@example.com');
writeFileSync(join(copy, 'src', 'App.tsx'), 'export const A = 1;\n');
writeFileSync(join(copy, 'content', 'ru', 'page.mdx'), '# Page\n');
writeFileSync(join(copy, 'README.md'), '# Readme\n');
git(copy, 'add', '-A');
git(copy, 'commit', '-qm', 'c');
git(copy, 'worktree', 'add', '-q', '-b', 'side', wt);

const CHILD = { AGENTDECK_SPLIT_CHILD: '1', AGENTDECK_USER_MEMORY_OFF: '1' };
type HookOut = {
  hookSpecificOutput?: {
    additionalContext?: string;
    permissionDecision?: string;
    permissionDecisionReason?: string;
  };
};
const transcriptPath = join(dir, 't.jsonl');
writeFileSync(
  transcriptPath,
  JSON.stringify({ type: 'user', message: { role: 'user', content: 'go' } }) + '\n',
);
function pre(session: string, tool: string, input: object, cwd = copy, child = false): HookOut {
  const out = spawnSync(process.execPath, [DISPATCH, 'pre'], {
    input: JSON.stringify({
      hook_event_name: 'PreToolUse',
      session_id: session,
      transcript_path: transcriptPath,
      cwd,
      tool_name: tool,
      tool_input: input,
    }),
    encoding: 'utf8',
    env: {
      ...process.env,
      AGENTDECK_KIT_VARIANT: '',
      AGENTDECK_HEAVY_QUEUE_DIR: '',
      AGENTDECK_KIT_STATE: STATE,
      ...(child ? CHILD : {}),
    },
    timeout: 15_000,
  }).stdout.trim();
  return out ? (JSON.parse(out) as HookOut) : {};
}
const ctx = (o: HookOut) => o.hookSpecificOutput?.additionalContext ?? '';
const why = (o: HookOut) => o.hookSpecificOutput?.permissionDecisionReason ?? '';
const denied = (o: HookOut) => o.hookSpecificOutput?.permissionDecision === 'deny';
let n = 0;
const sid = (tag: string) => `${tag}${++n}`.padEnd(12, 'x').slice(0, 12);

describe('rule-injector: правила не приходят туда, где неприменимы (g0 F4)', () => {
  const DEPTH = '# Verification depth';
  const write = (file_path: string) => pre(sid('kmfd'), 'Write', { file_path, content: 'x' });

  it('тест-файл в черновике (.agent/tmp, scratchpad, tmp/) — без verification-depth; настоящий — с ним', () => {
    expect(ctx(write(join(copy, '.agent', 'tmp', 'resolve-spec.mjs')))).not.toContain(DEPTH);
    expect(ctx(write(join(copy, 'tmp', 'probe.test.mjs')))).not.toContain(DEPTH);
    expect(
      ctx(write(join(tmpdir(), 'claude', 'p', 's', 'scratchpad', 'probe.test.mjs'))),
    ).not.toContain(DEPTH);
    // Контроль: настоящий spec-файл и тест одноразового репозитория прямо во временном каталоге.
    expect(ctx(write(join(copy, 'src', 'resolve.spec.mjs')))).toContain(DEPTH);
    expect(ctx(write(join(tmpdir(), `fixture-${process.pid}`, 'src', 'a.test.ts')))).toContain(
      DEPTH,
    );
  });

  it('во время rebase/merge карточка visible-fix-shots не отказывает (и у worktree)', () => {
    const arm = (s: string) => {
      mkdirSync(join(STATE, 'rules'), { recursive: true });
      writeFileSync(join(STATE, 'rules', `rule-visible-fix-shots-${s}.sent`), '1');
      return s;
    };
    const edit = (root: string, cwd = root) =>
      pre(
        arm(sid('kmfm')),
        'Edit',
        { file_path: join(root, 'src', 'App.tsx'), old_string: 'A = 1', new_string: 'A = 2' },
        cwd,
        true,
      );
    const plain = edit(copy);
    expect(denied(plain)).toBe(true);
    expect(why(plain)).toMatch(/visible-fix-shots/);

    writeFileSync(join(copy, '.git', 'MERGE_HEAD'), `${git(copy, 'rev-parse', 'HEAD').trim()}\n`);
    const merging = edit(copy);
    expect(denied(merging), why(merging)).toBe(false);
    expect(ctx(merging)).toMatch(/visible-fix-shots|Before\/after shots/);
    rmSync(join(copy, '.git', 'MERGE_HEAD'));

    mkdirSync(join(copy, '.git', 'rebase-merge'));
    expect(denied(edit(copy))).toBe(false);
    rmSync(join(copy, '.git', 'rebase-merge'), { recursive: true });

    // worktree: `.git` — файл, состояние перебазирования лежит в `<main>/.git/worktrees/<имя>`.
    expect(denied(edit(wt))).toBe(true);
    const wtGit = git(wt, 'rev-parse', '--absolute-git-dir').trim();
    mkdirSync(join(wtGit, 'rebase-apply'));
    const rebasing = edit(wt);
    rmSync(join(wtGit, 'rebase-apply'), { recursive: true });
    expect(denied(rebasing), why(rebasing)).toBe(false);
  });

  it('уже лежащая страница content/ — без doc-classification; новая и обычный документ — с ним', () => {
    const PLACE = '# Doc placement';
    const existing = pre(sid('kmfc'), 'Edit', {
      file_path: join(copy, 'content', 'ru', 'page.mdx'),
      old_string: 'Page',
      new_string: 'Page 2',
    });
    expect(ctx(existing)).not.toContain(PLACE);
    expect(ctx(write(join(copy, 'content', 'ru', 'new-page.mdx')))).toContain(PLACE);
    const readme = pre(sid('kmfc'), 'Edit', {
      file_path: join(copy, 'README.md'),
      old_string: 'Readme',
      new_string: 'Read me',
    });
    expect(ctx(readme)).toContain(PLACE);
  });
});
