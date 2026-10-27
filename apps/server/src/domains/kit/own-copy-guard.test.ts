import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { builtinKitDir } from './service.ts';

/**
 * Находка 5 наблюдения за группой (25.10): снимки BEFORE звено сняло с основной копии
 * человека — `npm --prefix <основная>/web-ui run dev -- --port 5180`. Исходники основной
 * копии уже ждали свежий `dist` соседнего пакета, сервер разработки падал на
 * `No matching export … parsePermission`, оба снимка вышли пустыми, а кэш Vite лёг в чужое
 * дерево. Группа запускает сервер разработки, сборку и снимки только из своей копии
 * (или из дерева, которое сама развернула внутри неё или в этом сеансе). Путь настоящий:
 * диспетчер набора `run.mjs pre` отдельным процессом, как его зовёт CLI; дерево — git-файлы
 * без процесса git, как их читает `split-worktree.mjs`.
 */

const DISPATCH = join(builtinKitDir(), 'hooks', 'lib', 'run.mjs');
const dir = mkdtempSync(join(tmpdir(), 'kit-own-copy-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const MAIN = join(dir, 'acme');
const COPY = join(dir, 'acme-worktrees', 'fix-PROJ-55-rbac');
const SIBLING = join(dir, 'acme-worktrees', 'fix-PROJ-56-audit');
const SCRATCH = join(dir, 'scratch-base');

function worktree(root: string, name: string, branch: string): void {
  const gitDir = join(MAIN, '.git', 'worktrees', name);
  mkdirSync(gitDir, { recursive: true });
  writeFileSync(join(gitDir, 'HEAD'), `ref: refs/heads/${branch}\n`);
  mkdirSync(join(root, 'web-ui'), { recursive: true });
  writeFileSync(join(root, '.git'), `gitdir: ${gitDir}\n`);
}

mkdirSync(join(MAIN, '.git'), { recursive: true });
writeFileSync(join(MAIN, '.git', 'HEAD'), 'ref: refs/heads/main\n');
mkdirSync(join(MAIN, 'web-ui'), { recursive: true });
mkdirSync(join(MAIN, 'tools'), { recursive: true });
worktree(COPY, 'fix-PROJ-55-rbac', 'fix/PROJ-55-rbac');
worktree(SIBLING, 'fix-PROJ-56-audit', 'fix/PROJ-56-audit');
// Дерево базы, развёрнутое внутри копии, и отсоединённое дерево этого сеанса во временной папке.
mkdirSync(join(COPY, '.agent', 'tmp', 'base', 'web-ui'), { recursive: true });
mkdirSync(join(SCRATCH, 'web-ui'), { recursive: true });
writeFileSync(
  join(SCRATCH, '.git'),
  `gitdir: ${join(MAIN, '.git', 'worktrees', 'scratch-base')}\n`,
);
mkdirSync(join(MAIN, '.git', 'worktrees', 'scratch-base'), { recursive: true });
writeFileSync(join(MAIN, '.git', 'worktrees', 'scratch-base', 'HEAD'), 'a7d73d36\n');

/** Git Bash spelling of a Windows path (`/c/…`) — the form the live command used. */
const msys = (p: string): string =>
  process.platform === 'win32'
    ? p.replace(/\\/g, '/').replace(/^([A-Za-z]):/, (_m, d: string) => `/${d.toLowerCase()}`)
    : p;

let n = 0;
function pre(
  command: string,
  opts: { split?: boolean; tool?: string; made?: string } = {},
): string {
  const transcript = join(dir, `t${++n}.jsonl`);
  const lines = [{ type: 'user', message: { role: 'user', content: 'стадия работы' } }];
  if (opts.made)
    lines.push({
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'w1', name: 'Bash', input: { command: opts.made } }],
      },
    } as never);
  writeFileSync(transcript, lines.map((l) => JSON.stringify(l)).join('\n') + '\n', 'utf8');
  const { AGENTDECK_SPLIT_CHILD: _drop, ...env } = process.env;
  const out = spawnSync(process.execPath, [DISPATCH, 'pre'], {
    input: JSON.stringify({
      hook_event_name: 'PreToolUse',
      tool_name: opts.tool ?? 'Bash',
      tool_input: { command, run_in_background: true },
      transcript_path: transcript,
      session_id: 'kit-own-copy',
      cwd: COPY,
    }),
    encoding: 'utf8',
    env: {
      ...env,
      ...(opts.split === false ? {} : { AGENTDECK_SPLIT_CHILD: '1' }),
      AGENTDECK_KIT_VARIANT: '',
      AGENTDECK_HEAVY_QUEUE_DIR: '',
      AGENTDECK_KIT_STATE: join(dir, 'state'),
    },
    timeout: 15_000,
  }).stdout.trim();
  const hook = out
    ? (JSON.parse(out) as {
        hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string };
      })
    : {};
  return hook.hookSpecificOutput?.permissionDecision === 'deny'
    ? (hook.hookSpecificOutput.permissionDecisionReason ?? '')
    : '';
}

describe('own-copy-guard: группа запускает сервер разработки и сборку только из своей копии', () => {
  it('живая команда: npm --prefix <основная копия>/web-ui run dev — отказ, причина называет копию', () => {
    const reason = pre(`npm --prefix ${msys(MAIN)}/web-ui run dev -- --port 5180`);
    expect(reason).toMatch(/own-copy-guard/);
    expect(reason).toContain(COPY.replace(/\\/g, '/'));
    expect(reason).toContain(MAIN.replace(/\\/g, '/'));
    expect(reason).toMatch(/git archive/);
  });

  it('cd в основную копию, затем pnpm dev / npx vite / сборка — отказ', () => {
    expect(pre(`cd ${msys(MAIN)}/web-ui && pnpm dev`)).toMatch(/own-copy-guard/);
    expect(pre(`cd "${MAIN}" && npx vite --port 5181`)).toMatch(/own-copy-guard/);
    expect(pre(`(cd ${msys(MAIN)} && yarn build)`)).toMatch(/own-copy-guard/);
    expect(pre(`pnpm -C ${msys(MAIN)}/web-ui run build:prod`)).toMatch(/own-copy-guard/);
    expect(pre(`node ${msys(MAIN)}/tools/shots.mjs BEFORE`)).toMatch(/own-copy-guard/);
  });

  it('соседняя копия другой группы через относительный путь — отказ', () => {
    expect(pre('npm --prefix ../fix-PROJ-56-audit/web-ui run start')).toMatch(/own-copy-guard/);
  });

  it('PowerShell: Set-Location в основную копию; npm run dev — отказ', () => {
    // Без кавычек: у PowerShell обратная косая — разделитель пути, а не экранирование.
    expect(pre(`Set-Location ${MAIN}; npm run dev`, { tool: 'PowerShell' })).toMatch(
      /own-copy-guard/,
    );
  });

  it('своя копия, дерево базы в .agent/tmp и дерево этого сеанса — проходят', () => {
    expect(pre('npm --prefix web-ui run dev -- --port 5181')).toBe('');
    expect(pre(`npm --prefix ${msys(COPY)}/web-ui run dev`)).toBe('');
    expect(pre('cd web-ui && pnpm build')).toBe('');
    expect(pre('npm --prefix .agent/tmp/base/web-ui run dev -- --port 5180')).toBe('');
    const made = `git worktree add --detach ${msys(SCRATCH)} a7d73d36`;
    expect(pre(`npm --prefix ${msys(SCRATCH)}/web-ui run dev`, { made })).toBe('');
    // Без записи о создании в транскрипте то же дерево — чужое.
    expect(pre(`npm --prefix ${msys(SCRATCH)}/web-ui run dev`)).toMatch(/own-copy-guard/);
  });

  it('чтение основной копии и не-серверные команды — проходят', () => {
    expect(pre(`git -C ${msys(MAIN)} log --oneline -3`)).toBe('');
    expect(pre(`npm --prefix ${msys(MAIN)}/web-ui ls vite`)).toBe('');
    expect(pre(`cd ${msys(MAIN)} && git status --short`)).toBe('');
  });

  it('вне группы разделения хук молчит', () => {
    expect(pre(`npm --prefix ${msys(MAIN)}/web-ui run dev`, { split: false })).toBe('');
  });
});
