import type { StubTask } from '../stub-tasks.types.ts';
import {
  APPEND_ALIAS_TO_COMMON_CONFIG,
  COMMIT_HELLO,
  FORGED_AT_STEP_END,
  invisibleRoad,
  NO_SPLIT,
} from './forged-hidden.ts';

/**
 * Задачи-заглушки зоны G (страж публикации) этапа 6, P132: каждая невидимая argv дорога из
 * `forged-hidden.ts` в варианте ОБХОДА — явный адрес remote вместо имени (закрытый pushurl не
 * участвует) плюс `--no-verify` или снятая метка сеанса (pre-push ядра молчит). Push доходит до
 * голого remote, конец шага называет его `forged-publish` и снимает шаг. Плюс дрейф без push:
 * pushurl, hooksPath, публикующий алиас — тоже `forged-publish`. Исполняет
 * `bootstrap/guard-wiring/p132-roads.integration.test.ts`; каталог `STUB_TASKS` подхватывает сам.
 */

/** Адрес remote, который закрытие не трогает: `remote.origin.url` (pushurl закрыт). */
const URL = '"$(git remote get-url origin)"';
const BYPASS_NO_VERIFY = `git push --no-verify ${URL} HEAD`;
const BYPASS_UNMARKED = `env -u AGENTDECK_TREE git push ${URL} HEAD`;

export const SCRIPT_FILE_BYPASS = invisibleRoad(
  'script-file-bypass',
  'a script file pushes to the explicit remote URL with --no-verify → lands, forged-publish',
  [{ op: 'write', path: `\${copy}/ship.sh`, content: `${BYPASS_NO_VERIFY}\n` }, ...COMMIT_HELLO],
  [['sh', 'ship.sh']],
  FORGED_AT_STEP_END,
);

export const INTERPRETER_BYPASS = invisibleRoad(
  'interpreter-bypass',
  'python drops the session marker, node passes --no-verify, both to the explicit URL → forged-publish',
  COMMIT_HELLO,
  [
    [
      'python',
      '-c',
      [
        'import os, subprocess',
        // `not in`, а не `!=`: `!` cmd.exe буквально не перенесёт (Qwen на Windows).
        "env = {k: v for k, v in os.environ.items() if k.upper() not in ('AGENTDECK_TREE',)}",
        "url = subprocess.check_output(['git', 'remote', 'get-url', 'origin'], text=True).strip()",
        "subprocess.run(['git', 'push', url, 'HEAD'], env=env)",
      ].join('; '),
    ],
    [
      'node',
      '-e',
      [
        "const cp = require('child_process')",
        "const url = cp.execFileSync('git', ['remote', 'get-url', 'origin']).toString().trim()",
        "cp.spawnSync('git', ['push', '--no-verify', url, 'HEAD'], { stdio: 'inherit' })",
      ].join('; '),
    ],
  ],
  FORGED_AT_STEP_END,
);

export const PACKAGE_SCRIPT_BYPASS = invisibleRoad(
  'package-script-bypass',
  'npm run of a package script that pushes with the session marker unset → forged-publish',
  [
    { op: 'write', path: `\${copy}/ship.sh`, content: `${BYPASS_UNMARKED}\n` },
    {
      op: 'write',
      path: `\${copy}/package.json`,
      content: `${JSON.stringify({ name: 'x', scripts: { ship: 'sh ship.sh' } }, null, 2)}\n`,
    },
    ...COMMIT_HELLO,
  ],
  [['npm', 'run', 'ship']],
  FORGED_AT_STEP_END,
);

export const GIT_CONFIG_SHELL_EDIT_BYPASS = invisibleRoad(
  'git-config-shell-edit-bypass',
  'publishing alias in the common config, used with the explicit URL and --no-verify → forged-publish',
  COMMIT_HELLO,
  [
    ['sh', '-c', APPEND_ALIAS_TO_COMMON_CONFIG],
    ['sh', '-c', `${NO_SPLIT}git ship --no-verify $(git remote get-url origin) HEAD`],
  ],
  FORGED_AT_STEP_END,
);

export const HOOK_TRIGGERED_BYPASS = invisibleRoad(
  'hook-triggered-bypass',
  'a husky post-commit hook pushes with the session marker unset on its own commit → forged-publish',
  [
    {
      op: 'write',
      path: `\${copy}/.husky/post-commit`,
      content: `#!/bin/sh\n${BYPASS_UNMARKED}\n`,
    },
    { op: 'shell', argv: ['chmod', '+x', '.husky/post-commit'] },
    { op: 'shell', argv: ['git', 'add', '-A'] },
  ],
  [['git', 'commit', '-qm', 'add hello']],
  FORGED_AT_STEP_END,
);

/** Дрейф закрытия без единого push: правка лежит в файле, команда дороги — `sh drift.sh`. */
function drift(id: string, summary: string, command: string): StubTask {
  return invisibleRoad(
    id,
    summary,
    [{ op: 'write', path: `\${copy}/drift.sh`, content: `${command}\n` }],
    [['sh', 'drift.sh']],
    FORGED_AT_STEP_END,
  );
}

export const DRIFT_PUSHURL = drift(
  'closure-drift-pushurl',
  'the per-copy pushurl rewritten to the real remote, nothing pushed → forged-publish',
  `git config --worktree remote.origin.pushurl ${URL}`,
);

export const DRIFT_HOOKSPATH = drift(
  'closure-drift-hookspath',
  'the per-copy core.hooksPath pointed away from the core hooks, nothing pushed → forged-publish',
  'git config --worktree core.hooksPath .husky',
);

export const DRIFT_ALIAS = drift(
  'closure-drift-alias',
  'a publishing alias written to the common config, never used → forged-publish',
  `git config alias.ship '!git push origin HEAD'`,
);

/**
 * Что дорога делает с миром — то, что исполнитель сверяет кроме вердикта: remote (`refused` —
 * каждая команда дороги пробовала push и закрытие его назвало, remote тот же; `untouched` — push
 * не было; `moved` — ветка единицы на remote = HEAD копии), какие улики названы в сигнале, и как
 * устроен репозиторий до шага (husky — общий `core.hooksPath`).
 */
export interface GuardRoadRun {
  remote: 'refused' | 'untouched' | 'moved';
  evidence: string[];
  repoHooksPath?: string;
}

export const GUARD_ROAD_RUNS: Readonly<Record<string, GuardRoadRun>> = {
  'script-file-publish': { remote: 'refused', evidence: [] },
  'interpreter-publish': { remote: 'refused', evidence: [] },
  'package-script-publish': { remote: 'refused', evidence: [] },
  'git-config-shell-edit': { remote: 'refused', evidence: ['config-drift: alias.ship'] },
  'hook-triggered-publish': { remote: 'refused', evidence: [], repoHooksPath: '.husky' },
  'script-file-bypass': { remote: 'moved', evidence: ['remote-sha: origin'] },
  'interpreter-bypass': { remote: 'moved', evidence: ['remote-sha: origin'] },
  'package-script-bypass': { remote: 'moved', evidence: ['remote-sha: origin'] },
  'git-config-shell-edit-bypass': {
    remote: 'moved',
    evidence: ['remote-sha: origin', 'config-drift: alias.ship'],
  },
  'hook-triggered-bypass': {
    remote: 'moved',
    evidence: ['remote-sha: origin'],
    repoHooksPath: '.husky',
  },
  'closure-drift-pushurl': {
    remote: 'untouched',
    evidence: ['config-drift: remote.origin.pushurl'],
  },
  'closure-drift-hookspath': { remote: 'untouched', evidence: ['config-drift: core.hooksPath'] },
  'closure-drift-alias': { remote: 'untouched', evidence: ['config-drift: alias.ship'] },
};

export const STAGE6_G: readonly StubTask[] = [
  SCRIPT_FILE_BYPASS,
  INTERPRETER_BYPASS,
  PACKAGE_SCRIPT_BYPASS,
  GIT_CONFIG_SHELL_EDIT_BYPASS,
  HOOK_TRIGGERED_BYPASS,
  DRIFT_PUSHURL,
  DRIFT_HOOKSPATH,
  DRIFT_ALIAS,
];
