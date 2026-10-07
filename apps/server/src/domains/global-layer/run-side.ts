import { readFileSync } from 'node:fs';
import { RUNNERS, type SideFindings } from './runners.ts';

/**
 * Точка входа дочернего процесса сверки: одна сторона пары на всех случаях.
 * Вход — JSON-файл задания (аргумент), выход — JSON в stdout. Падение на одном
 * случае не роняет остальные: оно пишется в `errors` этого случая.
 */

interface Job {
  runner: string;
  side: 'panel' | 'global';
  module: string;
  repos: { id: string; cwd: string }[];
}

const job = JSON.parse(readFileSync(process.argv[2] ?? '', 'utf8')) as Job;
const runner = RUNNERS[job.runner]?.[job.side];
const results: Record<string, SideFindings> = {};
const errors: Record<string, string> = {};

if (!runner) {
  errors['*'] = `unknown runner ${job.runner}`;
} else {
  for (const repo of job.repos) {
    try {
      results[repo.id] = await runner({ module: job.module, cwd: repo.cwd });
    } catch (error) {
      errors[repo.id] = error instanceof Error ? error.message : String(error);
    }
  }
}

process.stdout.write(JSON.stringify({ results, errors }));
