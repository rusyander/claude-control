import { describe, expect, it } from 'vitest';
import type { CopySetupInput, InstallRun } from './copy.types.ts';
import { decideCopySetup } from './decide.ts';
import { planInstall } from './install-plan.ts';
import { worktreeDirName } from './location.ts';
import { logTail } from './log.ts';
import { planMirror } from './mirror-plan.ts';

/**
 * Чистые части настройки копии (04:97-99): что зеркалится и что названо «за бортом», какой
 * командой ставятся зависимости, и судья `copy-setup` — провал этапа несёт хвост, пробел назван.
 */

const READY: CopySetupInput = {
  mirror: { value: { mirrored: [], skipped: [], unlisted: [], built: [], flagsFailed: [] } },
  env: { value: [] },
  plan: { steps: [], notes: [] },
  installs: [],
  reverted: { value: [] },
  longPaths: { value: 'on' },
};

function run(over: Partial<InstallRun> = {}): InstallRun {
  return {
    step: { stack: 'js-ts', root: '', command: 'pnpm', args: ['install'], why: 'pnpm-lock.yaml' },
    exit: 0,
    timedOut: false,
    ms: 1200,
    logFile: '/logs/install-1.log',
    tail: '',
    ...over,
  };
}

describe('copy setup plans', () => {
  describe('mirror plan', () => {
    it('listed ignored files go, unlisted top-level ignored is named, build env is named and never copied', () => {
      const plan = planMirror({
        flagged: [{ path: 'config/local.json', flag: 'skip-worktree' }],
        ignored: ['.env.local', 'secrets.txt', 'node_modules/', '.claude/', 'data/'],
        others: ['notes.local.md', 'draft.ts'],
        modified: ['src/app.ts'],
        settings: undefined,
        listDir: (dir) => (dir === '.claude' ? ['.claude/settings.local.json'] : []),
      });
      expect(plan.files).toEqual([
        '.claude/settings.local.json',
        '.env.local',
        'config/local.json',
        'notes.local.md',
      ]);
      expect(plan.unlisted).toEqual(['data/', 'secrets.txt']);
      expect(plan.built).toEqual(['node_modules/']);
    });

    it('the human list widens and narrows the mirror; an excluded file is not named as left behind', () => {
      const plan = planMirror({
        flagged: [],
        ignored: ['secrets.txt', '.env.prod'],
        others: [],
        modified: [],
        settings: { include: ['secrets.txt'], exclude: ['.env.prod'] },
        listDir: () => [],
      });
      expect(plan.files).toEqual(['secrets.txt']);
      expect(plan.unlisted).toEqual([]);
    });

    it('a nested ignored dir the list does not reach is named, not dropped silently', () => {
      const plan = planMirror({
        flagged: [],
        ignored: ['apps/web/.vercel/', 'apps/web/node_modules/'],
        others: [],
        modified: [],
        settings: undefined,
        listDir: () => ['apps/web/.vercel/.env.local'],
      });
      expect(plan.files).toEqual([]);
      expect(plan.unlisted).toEqual(['apps/web/.vercel/']);
      expect(plan.built).toEqual([]);
    });
  });

  describe('install plan', () => {
    it('lock file picks a frozen install per stack root; a stack without a lock is a note, not an invented step', () => {
      const files = new Set(['pnpm-lock.yaml', 'svc/go.mod']);
      const plan = planInstall(
        {
          stacks: [
            { stack: 'js-ts', root: '', workspace: 'pnpm' },
            { stack: 'js-ts', root: 'packages/a' },
            { stack: 'go', root: 'svc' },
            { stack: 'python', root: 'tools' },
          ],
          packageManager: null,
        },
        (rel) => files.has(rel),
      );
      expect(plan.steps.map((s) => `${s.root || '.'}: ${s.command} ${s.args.join(' ')}`)).toEqual([
        '.: pnpm install --frozen-lockfile --prefer-offline',
        'svc: go mod download',
      ]);
      expect(plan.notes.map((n) => n.subject)).toEqual(['python at tools']);
    });

    it('F-175: a nested root is covered only by workspace membership of its stack; separate projects get their own step, generic a note', () => {
      const files = new Set([
        'pnpm-lock.yaml',
        'tools/web/package-lock.json',
        'Cargo.lock',
        'crates/cli/Cargo.lock',
        'go.mod',
        'tools/go.mod',
      ]);
      const plan = planInstall(
        {
          stacks: [
            { stack: 'js-ts', root: '', workspace: 'pnpm' },
            // Член воркспейса без своего lock-файла — его ставит корень.
            { stack: 'js-ts', root: 'packages/a' },
            // Свой lock — самостоятельный проект (так его и выделяет профиль).
            { stack: 'js-ts', root: 'tools/web' },
            { stack: 'rust', root: '' },
            { stack: 'rust', root: 'crates/cli' },
            { stack: 'go', root: '' },
            { stack: 'go', root: 'tools' },
          ],
          packageManager: null,
        },
        (rel) => files.has(rel),
      );
      expect(plan.steps.map((s) => `${s.root || '.'}: ${s.command} ${s.args.join(' ')}`)).toEqual([
        '.: pnpm install --frozen-lockfile --prefer-offline',
        '.: cargo fetch --locked',
        '.: go mod download',
        'tools: go mod download',
        'tools/web: npm ci --prefer-offline --no-audit --no-fund',
        'crates/cli: cargo fetch --locked',
      ]);
      expect(plan.notes).toEqual([]);

      // Корень без воркспейса не покрывает вложенный пакет без lock-файла: заметка, не тишина.
      const flat = planInstall(
        {
          stacks: [
            { stack: 'js-ts', root: '' },
            { stack: 'js-ts', root: 'site' },
          ],
          packageManager: null,
        },
        (rel) => rel === 'pnpm-lock.yaml',
      );
      expect(flat.notes.map((n) => n.subject)).toEqual(['js-ts at site']);

      const generic = planInstall(
        { stacks: [{ stack: 'generic', root: '' }], packageManager: null },
        () => true,
      );
      expect(generic.steps).toEqual([]);
      expect(generic.notes).toEqual([
        {
          subject: 'generic at .',
          why: 'no known stack: no install command is detected, deps not installed; set the project install command',
        },
      ]);
    });

    it('the configured project install command wins over detection', () => {
      const plan = planInstall(
        { stacks: [{ stack: 'js-ts', root: '' }], packageManager: null },
        () => true,
        { command: 'make', args: ['deps'] },
      );
      expect(plan.steps).toEqual([
        {
          stack: 'generic',
          root: '',
          command: 'make',
          args: ['deps'],
          why: 'configured install command',
        },
      ]);
    });

    it('two lock files in one root: the declared packageManager decides', () => {
      const plan = planInstall(
        {
          stacks: [{ stack: 'js-ts', root: '' }],
          packageManager: { name: 'npm', version: '10.0.0' },
        },
        (rel) => rel === 'pnpm-lock.yaml' || rel === 'package-lock.json',
      );
      expect(plan.steps[0]?.command).toBe('npm');
    });
  });

  describe('copy-setup judge', () => {
    it('everything done: ready, environment prepared, nothing left behind', () => {
      const d = decideCopySetup({ ...READY, installs: [run()] });
      expect(d).toMatchObject({ verdict: 'ready', envPrepared: true, leftBehind: [] });
      expect(d.failure).toBeUndefined();
    });

    it('install failure is never silent: verdict failed, the step gets the log tail and the first error line', () => {
      const tail = logTail(
        'resolving…\nERR_PNPM_FETCH_404 GET https://registry/x: Not Found\ndone',
      );
      const d = decideCopySetup({ ...READY, installs: [run({ exit: 1, tail })] });
      expect(d.verdict).toBe('failed');
      expect(d.envPrepared).toBe(false);
      expect(d.failure).toMatchObject({ stage: 'install', tail });
      expect(d.failure?.firstError).toContain('ERR_PNPM_FETCH_404');
      expect(d.brief.join('\n')).toContain(tail);
      expect(d.leftBehind).toContainEqual({
        kind: 'install',
        subject: 'pnpm install in .',
        why: 'exit 1',
      });
    });

    it('create failure: failed at create, the copy itself is named as left behind', () => {
      const d = decideCopySetup({ createFailed: 'copy-create worktree-add' });
      expect(d.failure?.stage).toBe('create');
      expect(d.leftBehind[0]).toMatchObject({ kind: 'copy', subject: 'unit copy' });
    });

    it('an unread mirror is a failed stage with its reason, not a quiet copy without the local layer', () => {
      const d = decideCopySetup({ ...READY, mirror: { unknown: 'ls-files: exit 128' } });
      expect(d.verdict).toBe('failed');
      expect(d.failure).toMatchObject({ stage: 'mirror', tail: 'mirror: ls-files: exit 128' });
    });

    it('gaps are named on the unit: unlisted, build env, removed service var, no-lock note, unknown long paths', () => {
      const d = decideCopySetup({
        ...READY,
        mirror: {
          value: {
            mirrored: ['.env'],
            skipped: [{ path: 'big.local', why: 'over 8 MB' }],
            unlisted: ['data/'],
            built: ['.venv/'],
            flagsFailed: [],
          },
        },
        env: {
          value: [
            {
              file: '.env',
              name: 'DATABASE_URL',
              action: 'removed',
              why: 'no ephemeral db for this task',
            },
          ],
        },
        plan: { steps: [], notes: [{ subject: 'python at .', why: 'no uv.lock' }] },
        longPaths: { unknown: 'config read back failed' },
      });
      expect(d.verdict).toBe('ready-with-gaps');
      expect(d.leftBehind.map((l) => `${l.kind}:${l.subject}`)).toEqual([
        'unlisted:data/',
        'build-env:.venv/',
        'mirror-skip:big.local',
        'env-var:.env:DATABASE_URL',
        'install-note:python at .',
        'longpaths:core.longpaths',
      ]);
    });

    it('a lock file the install rewrote and the core reverted is logged, not a gap', () => {
      const d = decideCopySetup({
        ...READY,
        installs: [run()],
        reverted: { value: ['pnpm-lock.yaml'] },
      });
      expect(d.verdict).toBe('ready');
      expect(d.leftBehind).toEqual([
        { kind: 'lockfiles', subject: 'pnpm-lock.yaml', why: 'rewritten by install, reverted' },
      ]);
    });
  });

  describe('copy location', () => {
    it('Windows reserved device names get a suffix, also with superscript digits and an extension', () => {
      for (const name of ['con', 'COM1', 'com¹', 'lpt²', 'LPT³', 'CON.txt', 'nul.x', 'aux.tar.gz'])
        expect(worktreeDirName(name).split('.')[0]).toMatch(/-wt$/);
      expect(worktreeDirName('CON.txt')).toBe('CON-wt.txt');
      for (const name of ['console', 'com10', 'feature/con', 'nulls.txt'])
        expect(worktreeDirName(name)).not.toMatch(/-wt/);
    });
  });
});
