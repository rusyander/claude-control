import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DlpRule } from '@agentdeck/contracts';
import { AppStore } from '../lib/app-store.ts';
import { getProvider } from '../providers/registry.ts';
import { ProviderChatRun, type ProviderChatRunEvent } from './provider-chat/ProviderChatRun.ts';
import { panelSupervisorHooks } from './portability/supervisor/panel-hooks.ts';
import { applyPromptGate } from './prompt-gate.ts';
import { saveRules } from './dlp/rules-store.ts';

/**
 * КАЛИТКА ЗАПРОСОВ У ЧУЖОГО CLI (П6.2, критерий 2).
 *
 * Настоящее здесь всё, кроме самого чужого CLI: скрипт калитки собран рабочим
 * кодом и лежит на диске, правила прочитаны из общего с прокси `dlp-rules.json`,
 * журнал — тот же `dlp-journal.jsonl`, а скрипт запущен настоящей оболочкой
 * настоящим `node`. Подменена ровно внешняя граница — запуск CLI; подменённый
 * хук доказывал бы подмену, а не запрет.
 *
 * Проверяется не «функция вернула true», а последствия: прогон не начался,
 * процесс CLI не поднялся вовсе, человек получил причину с НАЗВАНИЕМ правила, и
 * в журнале появилась строка того же вида, что пишет Claude.
 */

const SECRET_RULE: DlpRule = {
  id: 'r1',
  name: 'Ключи доступа',
  enabled: true,
  kind: 'terms',
  terms: ['sk-живой-ключ'],
  pattern: '',
  action: 'block',
  label: 'КЛЮЧ',
};

describe('калитка запросов у чужого CLI', () => {
  let dir: string;
  let store: AppStore;
  let location: { hooksDir: string; settingsPath: string; appDataDir: string };
  let spawned: string[];

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'gate-foreign-'));
    location = {
      hooksDir: join(dir, 'hooks'),
      settingsPath: join(dir, 'settings.json'),
      appDataDir: join(dir, 'agentdeck'),
    };
    mkdirSync(location.hooksDir, { recursive: true });
    mkdirSync(location.appDataDir, { recursive: true });
    writeFileSync(location.settingsPath, '{}', 'utf8');
    store = new AppStore(join(dir, 'state.json'));
    saveRules(location.appDataDir, [SECRET_RULE]);
    spawned = [];
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  /**
   * Включить калитку по-настоящему — обеими половинами, как это делает маршрут:
   * настройка в состоянии панели и скрипт на диске. Порознь они и дают то
   * состояние, ради которого маршрут меняет их одним запросом.
   */
  function installGate(): void {
    store.updateSettings({ promptGate: { enabled: true, action: 'block' } });
    applyPromptGate(store, location, { enabled: true, action: 'block' });
  }

  /** Набор надзирателя ровно такой, какой собирает сервер на каждом сообщении. */
  function hooks() {
    return panelSupervisorHooks({
      settings: store.getSettings(),
      groups: store.getGroups(),
      hooksDir: location.hooksDir,
      skillsDir: join(dir, 'skills'),
    });
  }

  /**
   * Прогон чужого CLI. Запуск процесса подменён и ЗАПОМИНАЕТСЯ: «CLI не
   * запускался» — половина утверждения об отказе, и проверять её надо, а не
   * подразумевать.
   */
  async function run(providerId: string, prompt: string): Promise<ProviderChatRunEvent[]> {
    const events: ProviderChatRunEvent[] = [];
    await new ProviderChatRun().start(
      {
        provider: getProvider(providerId),
        history: [{ id: 'm1', role: 'user', content: prompt, at: '2026-09-21T10:00:00.000Z' }],
        chatId: 'chat-1',
        appDataDir: location.appDataDir,
        workdir: dir,
        supervisor: {
          run: {
            providerId,
            sessionId: 'chat-1',
            cwd: dir,
            transcriptPath: join(dir, 'chat-1.jsonl'),
          },
          hooks: hooks(),
        },
        // Путь до CLI: «нашёлся» — чтобы отказ калитки случился РАНЬШЕ выбора
        // раннера, а не потому, что запускать было нечего.
        detect: (command: string) => {
          spawned.push(`detect:${command}`);
          return true;
        },
        spawnImpl: ((command: string) => {
          spawned.push(command);
          throw new Error('CLI не должен запускаться: калитка отказала до него');
        }) as never,
      } as Parameters<ProviderChatRun['start']>[0],
      (event) => events.push(event),
    );
    return events;
  }

  /** Строки общего с прокси журнала. */
  function journal(): Record<string, unknown>[] {
    const path = join(location.appDataDir, 'dlp-journal.jsonl');
    if (!existsSync(path)) return [];
    return readFileSync(path, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
  }

  it('набор надзирателя несёт калитку как СОБСТВЕННУЮ запись панели', () => {
    installGate();

    const set = hooks();

    expect(set).toHaveLength(1);
    expect(set[0]?.event).toBe('UserPromptSubmit');
    // Своя запись панели: в файлы чужого CLI она не пишется, и продублировать её
    // целью нечем — только поэтому она вправе идти на родном для цели событии.
    expect(set[0]?.owner).toBe('panel');
  });

  it('калитка выключена — надзирателю нечего отыгрывать', () => {
    expect(hooks()).toHaveLength(0);
  });

  it('у CLI без своего события запрос не уходит, а причина называет правило', async () => {
    installGate();

    const events = await run('codex', 'Вот ключ sk-живой-ключ, почини деплой');

    const error = events.find((event) => event.type === 'error');
    expect(error).toMatchObject({ type: 'error', reason: 'hook_blocked' });
    expect(error && 'error' in error ? error.error : '').toContain('Ключи доступа');
    // CLI не поднимался вовсе: отказ случился ДО выбора раннера.
    expect(spawned.filter((entry) => !entry.startsWith('detect:'))).toEqual([]);
  });

  it('у CLI со СВОИМ событием калитка тоже отказывает — её хука в его файлах нет', async () => {
    installGate();

    // `qwen` объявляет `UserPromptSubmit` своим, и перенесённый хук отыграл бы
    // он сам. Калитку панель в его файлы не пишет никогда — значит отыграть её
    // некому, кроме надзирателя, и дубля при этом не возникает.
    const events = await run('qwen', 'Вот ключ sk-живой-ключ, почини деплой');

    expect(events.find((event) => event.type === 'error')).toMatchObject({
      reason: 'hook_blocked',
    });
  });

  it('журнал — тот же, что у прокси, и отказ в нём назван правилом', async () => {
    installGate();

    await run('codex', 'Вот ключ sk-живой-ключ, почини деплой');

    const lines = journal();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      path: 'hook:UserPromptSubmit',
      apiKind: 'prompt',
      decision: 'blocked',
      reason: 'Ключи доступа',
    });
    // Значение, из-за которого сработало правило, в журнал попасть не может.
    expect(JSON.stringify(lines[0])).not.toContain('sk-живой-ключ');
  });

  it('запрос без совпадений калитка пропускает', async () => {
    installGate();

    const events = await run('codex', 'Почини деплой, пожалуйста');

    expect(events.some((event) => event.type === 'error' && event.reason === 'hook_blocked')).toBe(
      false,
    );
    // Прогон дошёл до запуска CLI — то есть калитка его отпустила.
    expect(spawned.some((entry) => !entry.startsWith('detect:'))).toBe(true);
    expect(journal().every((line) => line.decision === 'passed')).toBe(true);
  });
});
