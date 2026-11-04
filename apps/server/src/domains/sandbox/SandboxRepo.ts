import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Рабочая папка песочницы как репозиторий для ядра (этап 10, F6): разговор песочницы — задача
 * ядра `chat@1` на месте, а оценка ядра принимает только репозиторий git. Своего проекта у
 * песочницы нет, поэтому папка заводится репозиторием с пустым первым коммитом — голова есть,
 * дерево пустое, файлы разговора остаются видны списком «что натворили».
 *
 * Хуки git пропускаются (`--no-verify`, пустой `core.hooksPath`): глобальные хуки человека к
 * песочнице отношения не имеют, а их отказ сорвал бы разговор. Имя автора — своё, локально у
 * команды: глобальной подписи у машины может не быть.
 */

const GIT_ENV = { ...process.env, GIT_TERMINAL_PROMPT: '0' };

function git(workDir: string, args: string[]): string | undefined {
  const out = spawnSync('git', args, {
    cwd: workDir,
    encoding: 'utf8',
    windowsHide: true,
    env: GIT_ENV,
    timeout: 30_000,
  });
  if (out.error) return out.error.message;
  if (out.status !== 0) return (out.stderr || out.stdout || `git exit ${out.status}`).trim();
  return undefined;
}

/**
 * Завести репозиторий в рабочей папке; уже есть с головой — ничего. Прерванное заведение (папка
 * `.git` без коммита) доводится первым коммитом. Возвращает причину отказа или `undefined`.
 */
export function ensureSandboxRepo(workDir: string): string | undefined {
  if (existsSync(join(workDir, '.git'))) {
    if (!git(workDir, ['rev-parse', '--verify', '-q', 'HEAD'])) return undefined;
  } else {
    const failed = git(workDir, ['init', '-q']);
    if (failed) return failed;
  }
  return git(workDir, [
    '-c',
    'user.name=agentdeck sandbox',
    '-c',
    'user.email=sandbox@agentdeck.invalid',
    '-c',
    'core.hooksPath=',
    '-c',
    'commit.gpgsign=false',
    'commit',
    '-q',
    '--no-verify',
    '--allow-empty',
    '-m',
    'sandbox',
  ]);
}
