import { RunnerError, type LaunchSpec } from './project-runner.types.ts';
import { coded } from '../../lib/server-text/server-text.ts';
import { detectCandidates, pickCandidate, type ToolCheck } from './stacks/stacks.ts';
import type { RunnerStack } from '@agentdeck/contracts';

/**
 * Чем и как запускается проект: пакетный менеджер, скрипт, итоговая команда.
 * Всё читается с диска и ничего не выполняет — тесты проверяют это на временных
 * каталогах без настоящего dev-сервера.
 */
export { detectPackageManager, detectRunScript, readPackageJson } from './stacks/node-package.ts';

/**
 * Разбор строки-оверрайда на слова с учётом кавычек: `node "my server.js" --port`
 * → ['node', 'my server.js', '--port']. Оверрайд задаёт пользователь для своего
 * проекта, поэтому достаточно простого разбора кавычек, без полного шелла.
 */
export function tokenize(command: string): string[] {
  const tokens: string[] = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(command)) !== null) {
    tokens.push(match[1] ?? match[2] ?? match[3] ?? '');
  }
  return tokens;
}

/**
 * Итоговая команда запуска: оверрайд (если задан) в приоритете, иначе первый
 * способ, найденный детекторами стеков (`stacks/`), чья программа есть на
 * машине. Ничего не нашли и оверрайда нет → RunnerError.
 */
/**
 * Стеки, где по адресу живёт API, а не страница. Задачи make/task/just сюда не
 * входят: за `make dev` бывает и фронтенд — там браузер по-прежнему открывается.
 */
const BACKEND_STACKS = new Set<RunnerStack>(['go', 'python', 'rust', 'java', 'dotnet']);

export function resolveRunCommand(
  targetDir: string,
  override?: string,
  projectRoot?: string,
  hasTool?: ToolCheck,
): LaunchSpec {
  const detected = detectCandidates({ dir: targetDir, root: projectRoot ?? targetDir }, hasTool);
  const trimmed = override?.trim();
  // Команда, выбранная из найденных, — это та же находка, а не своя строка:
  // запускаем её спекой, иначе потерялись бы каталог запуска (`go run ./cmd/api`
  // идёт из корня модуля) и то, как стек принимает закреплённый порт.
  const picked = trimmed ? detected.find((candidate) => candidate.display === trimmed) : undefined;
  if (trimmed && !picked) {
    const [file, ...args] = tokenize(trimmed);
    if (!file)
      throw coded(new RunnerError('no-script', 'Команда запуска пуста.'), 'runner-command-empty');
    return { file, args, display: trimmed };
  }

  const chosen = picked ?? pickCandidate(detected);
  if (!chosen) {
    throw coded(
      new RunnerError(
        'no-script',
        'Не нашли, чем запускать: ни скрипта dev/start в package.json, ни известного стека. Задайте команду запуска вручную.',
      ),
      'project-dev-script-missing',
    );
  }
  return {
    file: chosen.file,
    args: chosen.args,
    display: chosen.display,
    ...(chosen.cwd ? { cwd: chosen.cwd } : {}),
    ...(chosen.pinPort ? { pinPort: chosen.pinPort } : {}),
    ...(BACKEND_STACKS.has(chosen.stack) ? { browser: false } : {}),
  };
}
