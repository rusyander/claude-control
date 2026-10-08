import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isPidAlive, RunLedger } from '../chat/run-ledger/run-ledger.ts';
import { killPidTree } from '../../lib/process-tree/process-tree.ts';
import { sectionsOf } from './report.ts';
import {
  BackgroundWatcher,
  WATCHER_LEDGER_FILE,
  WATCHER_STATE_FILE,
  type BackgroundWatcherDeps,
} from './watcher.ts';
import type { WatchSignal } from './types.ts';

/**
 * Жизненный цикл наблюдателя на НАСТОЯЩЕМ процессе: вместо `claude` запускается
 * node с фальшивым CLI (`__fixtures__/fake-claude.mjs`), который читает промпт,
 * пишет свой argv и отвечает находкой. Подменён только сам CLI — запуск,
 * снятие дерева, журнал процесса, отчёт и файл состояния настоящие.
 */
const FAKE = fileURLToPath(new URL('./__fixtures__/fake-claude.mjs', import.meta.url));

const signal500: WatchSignal = {
  source: 'server',
  kind: 'http-5xx',
  method: 'GET',
  path: '/api/chats',
  status: 500,
  message: 'Cannot read properties of undefined',
};

describe('фоновый наблюдатель', () => {
  let appData: string;
  let cwd: string;
  let report: string;
  const watchers: BackgroundWatcher[] = [];
  const spawned: ChildProcess[] = [];

  beforeEach(() => {
    appData = mkdtempSync(join(tmpdir(), 'cc-watcher-data-'));
    cwd = mkdtempSync(join(tmpdir(), 'cc-watcher-cwd-'));
    report = join(cwd, 'WATCH-REPORT.md');
  });
  afterEach(() => {
    for (const watcher of watchers.splice(0)) watcher.shutdown();
    for (const child of spawned.splice(0)) if (child.pid && isPidAlive(child.pid)) child.kill();
    rmSync(appData, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  });

  const make = (extra: Partial<BackgroundWatcherDeps> = {}): BackgroundWatcher => {
    const watcher = new BackgroundWatcher({
      appDataDir: () => appData,
      reportPath: () => report,
      cwd,
      // Настоящий исполняемый файл: на Windows запуск идёт без оболочки.
      resolveCommand: () => process.execPath,
      model: () => 'haiku',
      pricing: () => ({
        overrides: {
          haiku: { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
        },
      }),
      spawnImpl: ((command: string, args: string[], options: object) => {
        const child = spawn(command, [FAKE, ...args], options);
        spawned.push(child);
        return child;
      }) as never,
      debounceMs: 10,
      ...extra,
    });
    watchers.push(watcher);
    return watcher;
  };

  const fake = (config: object): void =>
    writeFileSync(join(cwd, 'fake-config.json'), JSON.stringify(config));
  const argvDump = (): {
    argv: string[];
    prompt: string;
    systemPrompt: string;
    pid: number;
    envNames: string[];
  } => JSON.parse(readFileSync(join(cwd, 'fake-argv.json'), 'utf8'));

  const waitFor = async (condition: () => boolean, ms = 8000): Promise<boolean> => {
    for (let waited = 0; waited < ms; waited += 25) {
      if (condition()) return true;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    return condition();
  };

  it('выключен — сигнал не пишется никуда', () => {
    const watcher = make();
    expect(watcher.signal(signal500)).toBe(false);
    expect(existsSync(report)).toBe(false);
    expect(watcher.events.list()).toHaveLength(0);
  });

  // Испорченный `watcher.json` бросал из `readState`: старт панели падал в `resume`
  // (и dev-watch перезапускал её по кругу), а плановый разбор — необработанным отказом.
  it('испорченное состояние: панель стартует, наблюдатель выключен, процесс жив', async () => {
    writeFileSync(join(appData, WATCHER_STATE_FILE), '{"enabled": tr');
    const watcher = make();
    expect(() => watcher.resume()).not.toThrow();
    expect(watcher.isEnabled()).toBe(false);
    expect(watcher.status().enabled).toBe(false);

    const rejections: unknown[] = [];
    const onRejection = (reason: unknown): void => void rejections.push(reason);
    process.on('unhandledRejection', onRejection);
    try {
      // Любой бросок внутри разбора — здесь CLI, пропавший между сигналом и разбором.
      let calls = 0;
      const live = make({
        resolveCommand: () => {
          if (++calls > 1) throw new Error('PATH unreadable');
          return process.execPath;
        },
      });
      live.setEnabled(true);
      expect(live.signal(signal500)).toBe(true);
      await new Promise((resolve) => setTimeout(resolve, 100));
    } finally {
      process.off('unhandledRejection', onRejection);
    }
    expect(rejections).toEqual([]);
  });

  // Решение владельца 27.09: язык отчёта = язык интерфейса панели — и шапка с
  // разделами, и тексты, которые пишет модель (её просят писать на нём же).
  it('язык интерфейса английский — отчёт и просьба к модели на английском', async () => {
    const watcher = make({ language: () => 'en' });
    watcher.setEnabled(true);
    expect(watcher.signal(signal500)).toBe(true);
    await watcher.settled();
    const text = readFileSync(report, 'utf8');
    expect(text).toMatch(/^# Panel background watcher report/);
    expect(text).toContain('- **Status:** confirmed in code');
    expect(text).toContain('- **Location in code:** `apps/server/src/index.ts:1`');
    expect(argvDump().systemPrompt).toContain('MUST be written in English');

    const ru = make();
    rmSync(report, { force: true });
    ru.setEnabled(true);
    ru.signal({ ...signal500, path: '/api/other' });
    await ru.settled();
    expect(readFileSync(report, 'utf8')).toMatch(/^# Отчёт фонового наблюдателя панели/);
    expect(argvDump().systemPrompt).toContain('MUST be written in Russian');
  });

  it('включён: раздел в отчёте СРАЗУ, затем разбор только для чтения и вердикт на месте', async () => {
    const watcher = make();
    watcher.setEnabled(true);
    expect(watcher.signal(signal500)).toBe(true);
    // Раздел есть до всякого разбора — «пишется в момент обнаружения».
    const early = sectionsOf(readFileSync(report, 'utf8'));
    expect([...early.values()].map((s) => s.verdict)).toEqual(['pending']);

    await watcher.settled();
    const sections = sectionsOf(readFileSync(report, 'utf8'));
    expect(sections.size).toBe(1);
    expect([...sections.values()][0]).toMatchObject({ verdict: 'confirmed', count: 1 });

    const { argv, prompt } = argvDump();
    expect(argv.slice(argv.indexOf('--tools'), argv.indexOf('--tools') + 2)).toEqual([
      '--tools',
      'Read,Grep,Glob',
    ]);
    expect(argv).toContain('--no-session-persistence');
    expect(argv[argv.indexOf('--model') + 1]).toBe('haiku');
    expect(argv.join(' ')).not.toMatch(/Bash|Edit|Write/);
    expect(prompt).toContain('Cannot read properties of undefined');
    expect(watcher.status().pending).toBe(0);
  });

  it('расход копится по разборам: токены и оценка по тарифу', async () => {
    const watcher = make();
    watcher.setEnabled(true);
    watcher.signal(signal500);
    await watcher.settled();
    watcher.signal({ ...signal500, message: 'второй сбой' });
    await watcher.settled();
    const spend = watcher.status().spend;
    expect(spend).toMatchObject({
      runs: 2,
      input: 200,
      output: 40,
      cacheRead: 2000,
      cacheCreation: 100,
    });
    // haiku по своей цене: (100·1 + 20·5 + 1000·0.1 + 50·1.25)/1e6 за разбор.
    expect(spend.estimatedUsd).toBeCloseTo((2 * (100 + 100 + 100 + 62.5)) / 1e6, 12);

    // Выключили и включили снова — счёт с нуля, а не продолжение прошлого.
    watcher.setEnabled(false);
    expect(watcher.status().spend.runs).toBe(2);
    watcher.setEnabled(true);
    expect(watcher.status().spend).toMatchObject({ runs: 0, input: 0, output: 0 });
  });

  it('окружение разбора — только список агента панели: ключ из окружения сервера не уходит', async () => {
    const name = 'WATCHER_QA_SECRET_TOKEN';
    process.env[name] = 'must-not-leak';
    try {
      const watcher = make();
      watcher.setEnabled(true);
      watcher.signal(signal500);
      await watcher.settled();
      const { envNames } = argvDump();
      expect(envNames.map((key) => key.toUpperCase())).not.toContain(name);
      // Пустым окружение не стало: PATH нужен CLI, чтобы вообще стартовать.
      expect(envNames.map((key) => key.toUpperCase())).toContain('PATH');
    } finally {
      delete process.env[name];
    }
  });

  it('выключение снимает идущий разбор сразу: процесса больше нет, отчёт не тронут', async () => {
    fake({ sleepMs: 60_000 });
    const watcher = make();
    watcher.setEnabled(true);
    watcher.signal(signal500);
    expect(await waitFor(() => existsSync(join(cwd, 'fake-argv.json')))).toBe(true);
    const { pid } = argvDump();
    expect(isPidAlive(pid)).toBe(true);
    expect(watcher.status().analyzing).toBe(true);

    const status = watcher.setEnabled(false);
    expect(status.enabled).toBe(false);
    expect(status.analyzing).toBe(false);
    expect(await waitFor(() => !isPidAlive(pid))).toBe(true);
    // Журнал процесса пуст: сироты для следующего старта нет.
    expect(
      await waitFor(() => new RunLedger(appData, WATCHER_LEDGER_FILE).read().length === 0),
    ).toBe(true);
    const verdicts = [...sectionsOf(readFileSync(report, 'utf8')).values()].map((s) => s.verdict);
    expect(verdicts).toEqual(['pending']);
  });

  it('перезапуск панели: включённый продолжает и разбирает то, что не успел', async () => {
    fake({ sleepMs: 60_000 });
    const first = make();
    first.setEnabled(true);
    first.signal(signal500);
    expect(await waitFor(() => existsSync(join(cwd, 'fake-argv.json')))).toBe(true);
    // Смерть панели без обработчиков: процесс разбора остаётся сиротой.
    const orphan = argvDump().pid;
    rmSync(join(cwd, 'fake-argv.json'));
    fake({});

    const second = make();
    second.resume();
    expect(await waitFor(() => !isPidAlive(orphan))).toBe(true);
    expect(second.isEnabled()).toBe(true);
    await waitFor(() => existsSync(join(cwd, 'fake-argv.json')));
    await second.settled();
    const verdicts = [...sectionsOf(readFileSync(report, 'utf8')).values()].map((s) => s.verdict);
    expect(verdicts).toEqual(['confirmed']);
  });

  /**
   * F-145 (сосед): снимка процессов нет (F-205) — снятие со сверкой времени не
   * трогает номер и отдаёт `[]`. Раньше запись сироты всё равно стиралась, и
   * живой разбор прошлой жизни панели больше никто не добивал. Настоящие
   * процесс, пробы и `killPidTree`; подменён только снимок.
   */
  it('старт без снимка процессов: живая сирота не посчитана снятой, запись остаётся', () => {
    const orphan = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      stdio: 'ignore',
    });
    spawned.push(orphan);
    const pid = orphan.pid!;
    new RunLedger(appData, WATCHER_LEDGER_FILE).upsert({
      key: 'watcher',
      pid,
      cwd,
      startedAt: Date.now(),
    });

    const reaped = make().reapOrphans((target, startedAt) =>
      killPidTree(
        target,
        { spawnedAt: startedAt },
        { platform: 'win32', readTable: () => undefined },
      ),
    );

    expect(isPidAlive(pid)).toBe(true);
    expect(reaped).toBe(0);
    expect(new RunLedger(appData, WATCHER_LEDGER_FILE).read()).toEqual([
      expect.objectContaining({ key: 'watcher', pid }),
    ]);
  });

  it('CLI нет в PATH: причина словами, сбой всё равно в отчёте, процесс жив', async () => {
    const watcher = make({ resolveCommand: () => undefined });
    const status = watcher.setEnabled(true);
    expect(status.problem?.problemCode).toBe('cli_missing');
    expect(watcher.signal(signal500)).toBe(true);
    await watcher.settled();
    expect(sectionsOf(readFileSync(report, 'utf8')).size).toBe(1);
    expect(watcher.status().spend.runs).toBe(0);
  });

  it('отчёт не записывается: причина в статусе, наблюдатель продолжает копить', () => {
    const watcher = make({ reportPath: () => appData });
    watcher.setEnabled(true);
    expect(watcher.signal(signal500)).toBe(true);
    const status = watcher.status();
    expect(status.enabled).toBe(true);
    expect(status.problem?.problemCode).toBe('report_unwritable');
    expect(watcher.events.list()).toHaveLength(1);
  });

  it('упавший разбор не крутится сам по кругу и сказан в статусе', async () => {
    fake({ fail: true });
    const watcher = make();
    watcher.setEnabled(true);
    watcher.signal(signal500);
    await watcher.settled();
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(watcher.status().spend.runs).toBe(1);
    expect(watcher.status().problem?.problemCode).toBe('analysis_failed');
    expect(watcher.status().pending).toBe(1);
  });

  it('собственный неудачный запуск CLI наблюдателя — не новый сбой', async () => {
    const watcher = make({
      spawnImpl: (() => {
        watcher.signal({ source: 'server', kind: 'spawn-failed', message: 'self' });
        throw new Error('spawn EACCES');
      }) as never,
    });
    watcher.setEnabled(true);
    watcher.signal(signal500);
    await watcher.settled();
    expect(watcher.events.list().map((event) => event.kind)).toEqual(['http-5xx']);
  });

  it('выход с ошибкой СВОЕГО процесса разбора — не новый сбой, чужого — сбой', async () => {
    const watcher = make();
    watcher.setEnabled(true);
    watcher.signal(signal500);
    await watcher.settled();
    const { pid } = argvDump();
    expect(watcher.signal({ source: 'server', kind: 'cli-exit', message: 'own', pid })).toBe(false);
    expect(
      watcher.signal({ source: 'server', kind: 'cli-exit', message: 'чужой', pid: pid + 1 }),
    ).toBe(true);
  });

  it('потолок в час: сверх него разбора нет, раздел пишется, статус говорит словами', async () => {
    const watcher = make({ runsPerHour: 1 });
    watcher.setEnabled(true);
    watcher.signal(signal500);
    await watcher.settled();
    expect(watcher.status().hourlyCap).toEqual({ limit: 1, used: 1 });
    // Второй сбой: в отчёт — сразу, модели — нет, в статусе — «потолок».
    watcher.signal({ ...signal500, path: '/api/rules', message: 'другое' });
    await new Promise((resolve) => setTimeout(resolve, 150));
    const status = watcher.status();
    expect(status.spend.runs).toBe(1);
    expect(status.problem?.problemCode).toBe('hourly_cap');
    expect(status.problem?.message).toContain('1 разборов в час');
    expect(status.pending).toBe(1);
    expect(sectionsOf(readFileSync(report, 'utf8')).size).toBe(2);
    // Выключить-включить — не способ обойти потолок.
    watcher.setEnabled(false);
    watcher.setEnabled(true);
    expect(watcher.status().hourlyCap.used).toBe(1);
    watcher.shutdown();
  });

  it('потолок 0 в зависимостях — не RangeError: не меньше одного разбора в час', async () => {
    const watcher = make({ runsPerHour: 0 });
    watcher.setEnabled(true);
    expect(() => watcher.signal(signal500)).not.toThrow();
    await watcher.runOnce();
    await watcher.settled();
    expect(watcher.status().hourlyCap.limit).toBe(1);
    watcher.shutdown();
  });

  it('час прошёл — потолок снят, разбор идёт, замечание «потолок» уходит', async () => {
    let clock = Date.parse('2026-09-27T10:00:00.000Z');
    const watcher = make({ runsPerHour: 1, now: () => new Date(clock) });
    watcher.setEnabled(true);
    watcher.signal(signal500);
    await watcher.settled();
    watcher.signal({ ...signal500, path: '/api/rules', message: 'другое' });
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(watcher.status().problem?.problemCode).toBe('hourly_cap');
    clock += 61 * 60_000;
    await watcher.runOnce();
    await watcher.settled();
    expect(watcher.status().spend.runs).toBe(2);
    expect(watcher.status().problem).toBeUndefined();
  });

  it('модель: замечание — свой раздел с номером, «та же причина» — раздел влит и снят', async () => {
    fake({
      mergeIntoFirst: true,
      remarks: [
        {
          title: 'Состояние загрузки не сбрасывается при ошибке',
          explanation: 'После отказа флаг остаётся true.',
          severity: 'medium',
          location: 'apps/web/src/x.ts:12',
          fix: 'Сбрасывать в finally.',
        },
      ],
    });
    const watcher = make({ debounceMs: 50 });
    watcher.setEnabled(true);
    watcher.signal(signal500);
    watcher.signal({ ...signal500, path: '/api/rules', message: 'та же причина' });
    await watcher.settled();
    const text = readFileSync(report, 'utf8');
    const sections = [...sectionsOf(text).values()];
    expect(sections.map((s) => [s.ref, s.entryClass, s.count])).toEqual([
      ['WR-1', 'failure', 2],
      ['WR-3', 'remark', 1],
    ]);
    expect(text).toContain('- **Влиты как та же причина:** WR-2');
    expect(text).toContain('Состояние загрузки не сбрасывается при ошибке');
    expect(watcher.status()).toMatchObject({ findings: 2, remarks: 1 });
    // Повтор влитого идёт в раздел, куда влили; повтор замечания — счётчик, не новый раздел.
    fake({
      remarks: [
        {
          title: 'Состояние загрузки не сбрасывается при ошибке',
          explanation: 'снова',
          location: 'apps/web/src/x.ts:14',
        },
      ],
    });
    watcher.signal({ ...signal500, path: '/api/rules', message: 'та же причина' });
    await watcher.settled();
    const again = [...sectionsOf(readFileSync(report, 'utf8')).values()];
    expect(again.map((s) => [s.ref, s.count])).toEqual([
      ['WR-1', 3],
      ['WR-3', 2],
    ]);
    // Модели показаны уже известные разделы — ссылаться, а не дублировать.
    expect(argvDump().prompt).toContain(
      '- WR-3 [remark] Состояние загрузки не сбрасывается при ошибке',
    );
  });
});
