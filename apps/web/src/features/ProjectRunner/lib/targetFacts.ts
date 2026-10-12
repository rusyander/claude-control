import type { ProjectRunnerTarget, RunnerStack } from '@entities/ProjectRunner';

/** Имена стеков — собственные имена, не переводятся; `custom` — своя команда. */
const STACK_NAMES: Record<Exclude<RunnerStack, 'custom'>, string> = {
  node: 'Node.js',
  go: 'Go',
  python: 'Python',
  rust: 'Rust',
  java: 'Java',
  dotnet: '.NET',
  deno: 'Deno',
  make: 'make',
  task: 'Task',
  just: 'just',
};

/**
 * Подпись стека у цели: фреймворк точнее языка (`FastAPI`, а не `Python`).
 * Нет стека — старый ответ сервера или стабы проверок; подписи нет.
 */
export function stackLabel(
  stack: RunnerStack | undefined,
  framework: string | undefined,
  t: (key: string) => string,
): string | undefined {
  if (framework) return framework;
  if (!stack) return undefined;
  return stack === 'custom' ? t('runner.stackCustom') : STACK_NAMES[stack];
}

/**
 * Почему цель не запускается — своими словами панели. Сервер отдаёт причину
 * по-русски, а «программы нет» и «ничего не нашли» здесь называются на языке
 * интерфейса и с тем, что делать дальше.
 */
export function targetProblem(
  target: ProjectRunnerTarget,
  t: (key: string, options?: Record<string, unknown>) => string,
): string | undefined {
  if (target.runnable) return undefined;
  if (target.missingTool) return t('runner.missingTool', { tool: target.missingTool });
  if ((target.candidates ?? []).length === 0) return t('runner.nothingFound');
  return target.reason;
}
