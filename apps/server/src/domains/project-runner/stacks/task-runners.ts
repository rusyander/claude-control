import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { readText } from './fs-probe.ts';
import type { StackCandidate, StackProbe } from './stacks.types.ts';

/**
 * Задачи сборщиков проекта: Makefile, Taskfile, justfile.
 *
 * Если автор проекта завёл `make run`, это точнее любой догадки по языку: там
 * уже прописаны флаги, переменные и порядок. Поэтому такие задачи идут в списке
 * раньше `go run .` — но только с «запускающими» именами: `make up` чаще
 * поднимает Docker, а `make build` ничего не запускает вовсе.
 */
export const RUN_TASK_NAMES = ['dev', 'run', 'serve', 'start'] as const;

/** Имена целей Makefile: `name:` в начале строки, не присваивание `name := …`. */
export function makeTargets(text: string): string[] {
  const names: string[] = [];
  for (const match of text.matchAll(/^([A-Za-z0-9][A-Za-z0-9_.-]*)\s*:(?!=)/gm)) {
    const name = match[1];
    if (name && !names.includes(name)) names.push(name);
  }
  return names;
}

/** Рецепты justfile: `name:` или `name arg:` в начале строки. */
export function justRecipes(text: string): string[] {
  const names: string[] = [];
  for (const match of text.matchAll(/^@?([A-Za-z0-9][A-Za-z0-9_-]*)(?:\s+[^:\n]*)?:(?!=)/gm)) {
    const name = match[1];
    if (name && !names.includes(name)) names.push(name);
  }
  return names;
}

/** Задачи Taskfile — ключи `tasks`. */
export function taskfileTasks(text: string): string[] {
  try {
    const doc = parseYaml(text) as { tasks?: unknown };
    return doc?.tasks && typeof doc.tasks === 'object' ? Object.keys(doc.tasks) : [];
  } catch {
    return [];
  }
}

/** Первые «запускающие» имена в порядке `RUN_TASK_NAMES`. */
function runNames(available: string[]): string[] {
  return RUN_TASK_NAMES.filter((name) => available.includes(name));
}

export function taskRunnerCandidates({ dir }: StackProbe): StackCandidate[] {
  const found: StackCandidate[] = [];

  for (const name of ['Makefile', 'makefile', 'GNUmakefile']) {
    const text = readText(join(dir, name));
    if (text === undefined) continue;
    for (const target of runNames(makeTargets(text))) {
      found.push({
        stack: 'make',
        evidence: [join(dir, name)],
        file: 'make',
        args: [target],
        display: `make ${target}`,
        tool: 'make',
      });
    }
    break;
  }

  for (const name of ['Taskfile.yml', 'Taskfile.yaml', 'taskfile.yml', 'taskfile.yaml']) {
    const text = readText(join(dir, name));
    if (text === undefined) continue;
    for (const task of runNames(taskfileTasks(text))) {
      found.push({
        stack: 'task',
        evidence: [join(dir, name)],
        file: 'task',
        args: [task],
        display: `task ${task}`,
        tool: 'task',
      });
    }
    break;
  }

  for (const name of ['justfile', 'Justfile', '.justfile']) {
    const text = readText(join(dir, name));
    if (text === undefined) continue;
    for (const recipe of runNames(justRecipes(text))) {
      found.push({
        stack: 'just',
        evidence: [join(dir, name)],
        file: 'just',
        args: [recipe],
        display: `just ${recipe}`,
        tool: 'just',
      });
    }
    break;
  }

  return found;
}
