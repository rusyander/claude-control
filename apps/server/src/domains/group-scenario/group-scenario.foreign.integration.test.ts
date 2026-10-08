import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Group } from '@agentdeck/contracts';
import { AppStore } from '../../lib/app-store/app-store.ts';
import { getProvider } from '../../providers/registry.ts';
import { ProviderChatRun } from '../provider-chat/ProviderChatRun/ProviderChatRun.ts';
import { panelSupervisorHooks } from '../portability/supervisor/panel-hooks.ts';

/**
 * СТАРЫЙ СЦЕНАРИЙ ГРУППЫ БОЛЬШЕ НЕ ОТЫГРЫВАЕТСЯ У ЧУЖОГО CLI.
 *
 * Прежде надзиратель запуска панели ставил чужому CLI триггер сценария:
 * запрос под регулярку уезжал с порядком работы в контексте. Порядок работы
 * переехал в «Путь» и идёт ходами конвейера, поэтому подсказка по регулярке —
 * это дубль, который расходится с путём при первой правке.
 *
 * Доказательство — с конца пути: argv, уехавший чужому CLI. Запись группы с
 * `scenario` и триггером, записанная старой панелью, лежит в состоянии как есть.
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

  /** Запись группы, какой её оставила панель до «Пути»: сценарий с триггером. */
  function compile(): void {
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

  it('запрос под выражение уезжает CLI без старого порядка работы', async () => {
    compile();

    await ask('Сделай PRJ-42 к пятнице');

    // Запрос дошёл (не отказ блокирующего хука), и сценария в нём нет.
    expect(argv).toHaveLength(1);
    expect(sentToCli()).toContain('PRJ-42');
    expect(sentToCli()).not.toContain('Задача из Jira');
    expect(sentToCli()).not.toContain('Прочитать тикет');
  });
});
