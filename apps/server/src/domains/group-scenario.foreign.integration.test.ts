import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Group } from '@agentdeck/contracts';
import { AppStore } from '../lib/app-store.ts';
import { getProvider } from '../providers/registry.ts';
import { ProviderChatRun } from './provider-chat/ProviderChatRun.ts';
import { panelSupervisorHooks } from './portability/supervisor/panel-hooks.ts';
import { compileScenarioSkill } from './group-scenario.ts';

/**
 * СЦЕНАРИЙ ГРУППЫ ДЕЙСТВУЕТ У ЛЮБОГО ПРОВАЙДЕРА (П6.2, критерий 1).
 *
 * Сценарий компилируется в скилл и скрипт-триггер — записи канона панели. У
 * Claude триггер стоит его же хуком; у чужого CLI такого события нет вовсе, и
 * отыгрывает его надзиратель в запуске панели.
 *
 * Доказательство берётся с КОНЦА пути, а не с середины: проверяется текст,
 * который уехал в argv чужому CLI. Что «хук вернул строку» — утверждение о
 * хуке, а вопрос здесь другой: дошёл ли порядок работы до модели.
 *
 * Настоящее здесь всё, кроме самого CLI: скрипт триггера собран рабочим кодом,
 * лежит на диске и запущен настоящей оболочкой.
 */

/** Фейковый CLI: запоминает argv и молча закрывается. */
function recordingSpawn(argv: string[][]) {
  return ((command: string, args: string[]) => {
    argv.push([command, ...args]);
    const child = new EventEmitter() as EventEmitter & {
      stdout: EventEmitter;
      stderr: EventEmitter;
      stdin: { write: () => void; end: () => void; on: () => void };
      kill: () => void;
    };
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stdin = { write: () => {}, end: () => {}, on: () => {} };
    child.kill = () => child.emit('close', null);
    setTimeout(() => {
      child.stdout.emit('data', Buffer.from('готово'));
      child.emit('close', 0);
    }, 0);
    return child;
  }) as never;
}

describe('сценарий группы у чужого CLI', () => {
  let dir: string;
  let store: AppStore;
  let paths: { skills: string; settings: string; root: string };
  let argv: string[][];

  const group: Group = {
    id: 'g1',
    name: 'Задача из Jira',
    description: '',
    isEnabled: true,
    items: [],
    scenario: {
      when: 'Любая задача с номером тикета',
      trigger: 'PRJ-\\d+',
      steps: [
        { title: 'Прочитать тикет', body: 'Открыть описание', gate: 'условия выписаны' },
        { title: 'Показать план', body: '', gate: 'план согласован' },
      ],
    },
  } as unknown as Group;

  let savedPath: string | undefined;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'scenario-foreign-'));
    paths = {
      root: dir,
      skills: join(dir, 'skills'),
      settings: join(dir, 'settings.json'),
    };
    mkdirSync(paths.skills, { recursive: true });
    writeFileSync(paths.settings, '{}', 'utf8');
    store = new AppStore(join(dir, 'state.json'));
    argv = [];

    // Поддельный `codex.exe` на PATH — тем же приёмом, что в
    // `check-supervisor-skills.mjs`, и по той же причине. Дописанный в контекст
    // сценарий делает запрос МНОГОСТРОЧНЫМ, а многострочный запрос через
    // `.cmd`-обёртку Windows отказывает (`cmdWouldTruncate`). Известный предел
    // платформы подменил бы собой предмет проверки: отказ читался бы как
    // «сценарий не доехал», хотя он доехал и именно поэтому отказ и случился.
    const bin = join(dir, 'bin');
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, 'codex.exe'), '', 'utf8');
    savedPath = process.env.PATH;
    process.env.PATH = `${bin}${process.platform === 'win32' ? ';' : ':'}${savedPath ?? ''}`;
  });

  afterEach(() => {
    if (savedPath === undefined) delete process.env.PATH;
    else process.env.PATH = savedPath;
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  /** Завести сценарий так, как это делает сохранение группы в панели. */
  function compile(): void {
    compileScenarioSkill({ paths, store, backupDir: join(dir, 'backups') } as never, group);
    store.saveGroup(group);
  }

  async function ask(prompt: string): Promise<void> {
    await new ProviderChatRun().start(
      {
        provider: getProvider('codex'),
        history: [{ id: 'm1', role: 'user', content: prompt, at: '2026-09-21T10:00:00.000Z' }],
        chatId: 'chat-1',
        appDataDir: dir,
        workdir: dir,
        supervisor: {
          run: {
            providerId: 'codex',
            sessionId: 'chat-1',
            cwd: dir,
            transcriptPath: join(dir, 'chat-1.jsonl'),
          },
          hooks: panelSupervisorHooks({
            settings: store.getSettings(),
            groups: store.getGroups(),
            hooksDir: join(dir, 'hooks'),
            skillsDir: paths.skills,
          }),
        },
        detect: () => true,
        spawnImpl: recordingSpawn(argv),
      } as Parameters<ProviderChatRun['start']>[0],
      () => {},
    );
  }

  const sentToCli = (): string => argv.map((line) => line.join(' ')).join('\n');

  it('запрос под выражение уезжает CLI вместе с порядком работы', async () => {
    compile();

    await ask('Сделай PRJ-42 к пятнице');

    expect(argv).toHaveLength(1);
    expect(sentToCli()).toContain('Задача из Jira');
    // Путь к телу сценария — НАСТОЯЩИЙ файл панели, а не «~/.claude/skills/…»:
    // у чужого CLI дом Claude не дом, и такая строка была бы обещанием файла,
    // которого по названному адресу нет.
    const skillPath = join(paths.skills, 'scenario-zadacha-iz-jira', 'SKILL.md');
    expect(sentToCli()).toContain(skillPath);
    expect(readFileSync(skillPath, 'utf8')).toContain('Прочитать тикет');
  });

  it('запрос мимо выражения ничего не навязывает', async () => {
    compile();

    await ask('Почини деплой');

    expect(argv).toHaveLength(1);
    expect(sentToCli()).not.toContain('Задача из Jira');
  });

  /**
   * Скилл сценария человек удалил с диска руками (панель об этом не знает).
   *
   * `UserPromptSubmit` — событие блокирующее, и хук, чьего файла нет, вернул бы
   * код выхода 1: решение неизвестно, значит отказ. Один удалённый файл остановил
   * бы ВСЮ переписку со всеми чужими CLI, поэтому проверка смотрит не на список
   * хуков, а на то, доехал ли запрос до CLI вообще.
   */
  it('удалённый скрипт триггера не отказывает в каждом сообщении', async () => {
    compile();
    rmSync(join(paths.skills, 'scenario-zadacha-iz-jira'), { recursive: true, force: true });

    await ask('Сделай PRJ-42 к пятнице');

    expect(argv).toHaveLength(1);
    // Порядка работы в запросе нет — взять его неоткуда, и это честно.
    expect(sentToCli()).not.toContain('Задача из Jira');
  });

  it('выключенная группа не срабатывает', async () => {
    compile();
    store.saveGroup({ ...group, isEnabled: false });

    await ask('Сделай PRJ-42 к пятнице');

    expect(sentToCli()).not.toContain('Задача из Jira');
  });
});
