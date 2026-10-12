import { join } from 'node:path';
import { detectPackageManager, detectRunScript } from './node-package.ts';
import { readText } from './fs-probe.ts';
import type { StackCandidate, StackProbe } from './stacks.types.ts';

/**
 * Node: скрипт `dev`/`start` из package.json через пакетный менеджер проекта —
 * прежнее поведение запускалки, теперь одним кандидатом из многих.
 */
export function nodeCandidates({ dir, root }: StackProbe): StackCandidate[] {
  const script = detectRunScript(dir);
  if (!script) return [];
  const pm = detectPackageManager(dir, root);
  return [
    {
      stack: 'node',
      evidence: [join(dir, 'package.json')],
      file: pm,
      args: ['run', script],
      display: `${pm} run ${script}`,
      tool: pm,
    },
  ];
}

/** Deno: задача `dev`/`start` из deno.json(c). */
export function denoCandidates({ dir }: StackProbe): StackCandidate[] {
  for (const name of ['deno.json', 'deno.jsonc']) {
    const text = readText(join(dir, name));
    const tasksAt = text?.indexOf('"tasks"') ?? -1;
    if (text === undefined || tasksAt < 0) continue;
    // deno.jsonc допускает комментарии: строку задачи ищем регуляркой, не JSON.parse.
    const tasks = text.slice(tasksAt);
    const task = ['dev', 'start'].find((name) => new RegExp(`"${name}"\\s*:`).test(tasks));
    if (!task) continue;
    return [
      {
        stack: 'deno',
        evidence: [join(dir, name)],
        file: 'deno',
        args: ['task', task],
        display: `deno task ${task}`,
        tool: 'deno',
      },
    ];
  }
  return [];
}
