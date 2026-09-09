import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { WorktreeBootstraps, bootstrapCommandFor, detectBootstrapCommand } from './project-git.ts';
import { logTail } from './project-git/bootstrap.ts';
import { parseChurn } from './project-git/lockfiles.ts';

/**
 * Бутстрап копии (T5): выбор команды — на файлах, запуск — на настоящих
 * процессах `node -e`, потому что таймаут, код выхода и лог подделкой не
 * доказываются. Команды короткие: тест не ставит зависимостей.
 */

function dropTemp(target: string): void {
  try {
    rmSync(target, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  } catch {
    // Каталог остаётся в temp — на результат теста это не влияет.
  }
}

const NODE = process.execPath.includes(' ') ? `"${process.execPath}"` : process.execPath;

describe('detectBootstrapCommand: по lock-файлу в корне', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cc-boot-detect-'));
  });
  afterEach(() => dropTemp(dir));

  it('pnpm / npm / yarn — своя команда, без lock-файла — ничего', () => {
    expect(detectBootstrapCommand(dir)).toBeUndefined();
    writeFileSync(join(dir, 'yarn.lock'), '');
    expect(detectBootstrapCommand(dir)).toBe('yarn install --immutable');
    writeFileSync(join(dir, 'package-lock.json'), '{}');
    expect(detectBootstrapCommand(dir)).toBe('npm ci');
    writeFileSync(join(dir, 'pnpm-lock.yaml'), '');
    expect(detectBootstrapCommand(dir)).toBe('pnpm install --frozen-lockfile --prefer-offline');
  });

  it('настроенная команда сильнее автоопределения, пустая — «определи сама»', () => {
    writeFileSync(join(dir, 'pnpm-lock.yaml'), '');
    expect(bootstrapCommandFor(dir, '  make setup  ')).toBe('make setup');
    expect(bootstrapCommandFor(dir, '   ')).toBe('pnpm install --frozen-lockfile --prefer-offline');
    expect(bootstrapCommandFor(dir, undefined)).toBe(
      'pnpm install --frozen-lockfile --prefer-offline',
    );
  });
});

describe('logTail', () => {
  it('режет с начала целой строки', () => {
    const text = `${'a'.repeat(50)}\n${'b'.repeat(50)}\n${'c'.repeat(50)}`;
    const tail = logTail(text, 80);
    expect(tail.startsWith('c')).toBe(true);
    expect(tail.length).toBeLessThanOrEqual(80);
    expect(logTail('short', 80)).toBe('short');
  });
});

describe('parseChurn: разбор porcelain для lock-файлов', () => {
  it('отслеживаемые и новые файлы различаются', () => {
    expect(parseChurn(' M package-lock.json\0?? bun.lock\0')).toEqual([
      { path: 'package-lock.json', tracked: true },
      { path: 'bun.lock', tracked: false },
    ]);
    expect(parseChurn('')).toEqual([]);
  });
});

describe('WorktreeBootstraps: настоящие процессы', () => {
  let logs: string;
  let copy: string;

  beforeEach(() => {
    logs = mkdtempSync(join(tmpdir(), 'cc-boot-logs-'));
    copy = mkdtempSync(join(tmpdir(), 'cc-boot-copy-'));
  });
  afterEach(() => {
    dropTemp(logs);
    dropTemp(copy);
  });

  it('удачная команда: ok, лог на диске, запись переживает новый экземпляр', async () => {
    const boots = new WorktreeBootstraps(logs);
    expect(boots.status(copy)).toBeUndefined();

    const done = await boots.run(copy, `${NODE} -e "console.log('BOOT-OK')"`);
    expect(done.status).toBe('ok');
    expect(done.exitCode).toBe(0);
    expect(done.logTail).toContain('BOOT-OK');
    expect(done.finishedAt).toBeDefined();
    expect(existsSync(boots.logPath(copy))).toBe(true);
    expect(readFileSync(boots.logPath(copy), 'utf8')).toContain('BOOT-OK');
    expect(boots.log(copy)).toContain('BOOT-OK');

    const fresh = new WorktreeBootstraps(logs);
    expect(fresh.status(copy)).toMatchObject({ status: 'ok', exitCode: 0 });
  });

  it('после команды идёт откат lock-файлов: список в состоянии и в логе', async () => {
    const boots = new WorktreeBootstraps(logs, {
      afterRun: async () => ['package-lock.json'],
    });
    const done = await boots.run(copy, `${NODE} -e "process.exit(2)"`);
    expect(done.status).toBe('failed');
    expect(done.reverted).toEqual(['package-lock.json']);
    expect(done.logTail).toContain('lock-файлы откачены: package-lock.json');
    // Отказ отката не портит итог команды.
    const fragile = new WorktreeBootstraps(logs, {
      afterRun: async () => {
        throw new Error('git не ответил');
      },
    });
    const ok = await fragile.run(copy, `${NODE} -e "console.log('fine')"`);
    expect(ok.status).toBe('ok');
    expect(ok.reverted).toBeUndefined();
  });

  it('ненулевой код — failed с кодом, а не исключение', async () => {
    const boots = new WorktreeBootstraps(logs);
    const done = await boots.run(copy, `${NODE} -e "console.error('boom'); process.exit(3)"`);
    expect(done.status).toBe('failed');
    expect(done.exitCode).toBe(3);
    expect(done.logTail).toContain('boom');
  });

  it('потолок времени останавливает процесс и помечает timedOut', async () => {
    const boots = new WorktreeBootstraps(logs, { timeoutMs: 400 });
    const done = await boots.run(copy, `${NODE} -e "setTimeout(() => {}, 20000)"`);
    expect(done.status).toBe('failed');
    expect(done.timedOut).toBe(true);
    expect(done.logTail).toContain('потолок');
  }, 10_000);

  it('повторный запуск поверх идущего возвращает тот же результат', async () => {
    const boots = new WorktreeBootstraps(logs);
    const first = boots.run(copy, `${NODE} -e "setTimeout(() => console.log('one'), 200)"`);
    expect(boots.isRunning(copy)).toBe(true);
    expect(boots.status(copy)?.status).toBe('running');
    const second = boots.run(copy, `${NODE} -e "console.log('two')"`);
    expect(second).toBe(first);
    const done = await first;
    expect(done.logTail).toContain('one');
    expect(done.logTail).not.toContain('two');
    expect(boots.isRunning(copy)).toBe(false);
  });

  it('запись «идёт» без процесса (перезапуск панели) читается как провал', () => {
    const boots = new WorktreeBootstraps(logs);
    const slug = boots.slugFor(copy);
    writeFileSync(
      join(logs, `${slug}.json`),
      JSON.stringify({
        command: 'pnpm install',
        status: 'running',
        startedAt: '2026-09-09T10:00:00.000Z',
        logTail: 'Progress: 10/200',
      }),
    );
    const state = boots.status(copy);
    expect(state?.status).toBe('failed');
    expect(state?.logTail).toContain('перезапущена');
    expect(state?.finishedAt).toBeDefined();
  });

  it('несуществующая команда — failed, а не исключение', async () => {
    const boots = new WorktreeBootstraps(logs);
    const done = await boots.run(copy, 'definitely-no-such-command-xyz');
    expect(done.status).toBe('failed');
  });
});
