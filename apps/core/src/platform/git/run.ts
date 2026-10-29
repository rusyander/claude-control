import { gitBaseArgs } from '../encoding.ts';
import { currentOs } from '../os-kind.ts';
import { longForm } from '../paths.ts';
import { runTool } from '../run-tool.ts';
import type { GitOptions } from './git.types.ts';

/**
 * Переменные, которыми git, запущенный из хука или из чужой сессии, уводит команду в другой
 * репозиторий или индекс. Ядро читает дерево того репозитория, путь которого назван, — поэтому
 * они снимаются (имя без регистра: Windows хранит `Git_Dir` так же, как `GIT_DIR`).
 */
const GIT_ENV_DROP = new Set([
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_INDEX_FILE',
  'GIT_COMMON_DIR',
  'GIT_PREFIX',
  'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_NAMESPACE',
]);

export function gitEnv(
  extra: Record<string, string> = {},
  base: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(base)) {
    if (!GIT_ENV_DROP.has(name.toUpperCase())) out[name] = value;
  }
  // Чтение не берёт замков настоящего индекса и не ждёт пароля: молчаливое ожидание — не ответ.
  out.GIT_OPTIONAL_LOCKS = '0';
  out.GIT_TERMINAL_PROMPT = '0';
  return { ...out, ...extra };
}

export interface GitCall extends GitOptions {
  timeoutMs: number;
  extraEnv?: Record<string, string>;
  /** Ненулевой код — ответ, а не сбой (например, `rev-parse --verify --quiet`). */
  acceptNonZero?: boolean;
}

export interface GitOutput {
  code: number | null;
  stdout: string;
}

/** Один вызов git в репозитории; отказ запуска и таймаут — исключение (читатель факта даст `unknown`). */
export async function git(repo: string, args: string[], call: GitCall): Promise<GitOutput> {
  const os = call.os ?? currentOs();
  const run = call.run ?? runTool;
  const result = await run('git', [...gitBaseArgs(os), '-C', longForm(repo, os), ...args], {
    timeoutMs: call.timeoutMs,
    env: gitEnv(call.extraEnv, call.env),
    acceptNonZero: call.acceptNonZero,
  });
  if (!result.ok) {
    const stderr = result.stderr?.trim();
    throw new Error(`git ${args[0]}: ${result.reason}${stderr ? `: ${stderr}` : ''}`);
  }
  return { code: result.code, stdout: result.stdout };
}
