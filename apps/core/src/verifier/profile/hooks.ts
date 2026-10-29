import { baseName, type ViewIndex } from './view.ts';

/**
 * Git-хуки проекта (04:48, 04:133): они идут на собственном коммите и пуше ядра, а их проверки
 * прогоняются заранее как проверки профиля. Источники — каталоги хуков (`.husky/`, `.githooks/`,
 * `.git/hooks/` без `.sample`) и конфиги менеджеров хуков (lefthook, pre-commit, simple-git-hooks,
 * husky 4 в package.json). Имя принимается, только если git знает такой хук.
 */

const GIT_HOOKS = new Set([
  'applypatch-msg',
  'pre-applypatch',
  'post-applypatch',
  'pre-commit',
  'pre-merge-commit',
  'prepare-commit-msg',
  'commit-msg',
  'post-commit',
  'pre-rebase',
  'post-checkout',
  'post-merge',
  'pre-push',
  'pre-receive',
  'update',
  'proc-receive',
  'post-receive',
  'post-update',
  'reference-transaction',
  'push-to-checkout',
  'pre-auto-gc',
  'post-rewrite',
  'sendemail-validate',
  'fsmonitor-watchman',
  'post-index-change',
]);

export function detectGitHooks(view: ViewIndex): string[] {
  const found = new Set<string>();
  const add = (name: string): void => {
    if (GIT_HOOKS.has(name)) found.add(name);
  };
  for (const f of view.matching((p) => /^(\.husky|\.githooks|\.git\/hooks)\/[^/]+$/.test(p)))
    add(baseName(f.path));
  for (const name of ['lefthook.yml', 'lefthook.yaml', '.lefthook.yml']) {
    const text = view.text(name);
    if (text === undefined) continue;
    for (const line of text.split(/\r?\n/)) {
      const key = /^([a-z-]+)\s*:/.exec(line);
      if (key) add(key[1] as string);
    }
  }
  const preCommit = view.text('.pre-commit-config.yaml');
  if (preCommit !== undefined) {
    add('pre-commit');
    // Стадии из `default_install_hook_types` / `stages` — те же имена хуков git.
    for (const m of preCommit.matchAll(
      /\b(pre-push|commit-msg|pre-merge-commit|post-checkout|prepare-commit-msg)\b/g,
    ))
      add(m[1] as string);
  }
  const pkg = view.json('package.json');
  for (const block of [
    pkg?.['simple-git-hooks'],
    (pkg?.husky as { hooks?: unknown } | undefined)?.hooks,
  ]) {
    if (block && typeof block === 'object') for (const k of Object.keys(block)) add(k);
  }
  return [...found].sort();
}
