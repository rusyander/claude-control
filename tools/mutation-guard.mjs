// Отказ прогона тестов, пока mustfail другого процесса держит файлы этого дерева подменёнными.
//
// mustfail подменяет файлы прямо в рабочей копии и пишет журнал `<git-path mustfail>/journal-<pid>.json`.
// Несколько агентов работают в одной копии: 28.10 «нестабильные» тесты платформы ядра оказались
// чужими мутантами (`diffListeners → []`, keepalive), прогнанными посреди набора другого агента, — часы
// на разбор ложной причины. Красное или зелёное посреди чужой мутации ничего не доказывает, поэтому
// прогон отказывается сразу и называет, кто держит дерево. Свой прогон mustfail не мешает: mustfail
// ставит детям MUSTFAIL_PID, и журнал с этим pid пропускается.
import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

const git = (cwd, args) => {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim() : '';
};

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
};

/**
 * Живой чужой прогон mustfail в дереве `cwd`, или null.
 * Нечитаемый журнал тоже считается мутацией: mustfail сам отказывается работать при таком журнале.
 * @param {{cwd?: string, env?: NodeJS.ProcessEnv, isAlive?: (pid: number) => boolean}} [opts]
 */
export function foreignMutation({ cwd = process.cwd(), env = process.env, isAlive = alive } = {}) {
  const top = git(cwd, ['rev-parse', '--show-toplevel']);
  if (!top) return null;
  const dir = resolve(cwd, git(cwd, ['rev-parse', '--git-path', 'mustfail']));
  const scope = top.replace(/\\/g, '/').toLowerCase();
  const own = Number(env.MUSTFAIL_PID) || 0;
  let names;
  try {
    names = readdirSync(dir).filter((n) => /^journal-\d+\.json$/.test(n));
  } catch {
    return null;
  }
  for (const name of names) {
    const file = join(dir, name);
    let j;
    try {
      j = JSON.parse(readFileSync(file, 'utf8'));
    } catch {
      return {
        file,
        pid: Number(name.match(/\d+/)[0]),
        started: 'unknown',
        files: [],
        unreadable: true,
      };
    }
    if (j.scope !== scope || j.pid === own || !isAlive(j.pid)) continue;
    return { file, pid: j.pid, started: j.started, files: Object.keys(j.files ?? {}) };
  }
  return null;
}

/** Текст отказа: кто держит дерево и что делать. */
export function describeMutation(m) {
  const head = m.unreadable
    ? `mutation-guard: журнал mustfail ${m.file} не читается — файлы дерева могли остаться подменёнными.`
    : `mutation-guard: mustfail (pid ${m.pid}, начат ${m.started}) прямо сейчас подменяет файлы этого дерева.`;
  const files = m.files.length
    ? ` Файлы: ${m.files.slice(0, 5).join(', ')}${m.files.length > 5 ? ', …' : ''}.`
    : '';
  return (
    `${head}${files} Результат прогона сейчас ничего не доказывает — повторите после его конца. ` +
    `Если pid ${m.pid} — не mustfail, удалите ${m.file}.`
  );
}

/** globalSetup vitest: прогон посреди чужой мутации отказывается до первого теста. */
export function setup() {
  const m = foreignMutation();
  if (m) throw new Error(describeMutation(m));
}
