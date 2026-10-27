import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdtempSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { HANDOFF_BLOCK_LANG } from '@agentdeck/contracts/chat-handoff';
import { foreignChatKey } from '@agentdeck/contracts/foreign-chat-key';
import { AppStore } from '../../lib/app-store/app-store.ts';
import type { ServerContext } from '../../context.ts';
import type { ChatLink, SplitPlanRecord } from '../../lib/app-store/app-store.types.ts';
import {
  ProviderChatRun,
  type ProviderChatRunLike,
} from '../../domains/provider-chat/ProviderChatRun/ProviderChatRun.ts';
import { createChat, readChat } from '../../domains/provider-chat/store/store.ts';
import { getProvider } from '../../providers/registry.ts';
import { removeWhenFree } from '../../lib/remove-when-free.ts';
import { createRuntime, type Runtime } from './runtime.ts';

/**
 * P-24 (паритет d9869abf:9 / g9 #133): продолжение группы чужого CLI в чистой
 * сессии, оборванное паузой до первого хода, после «Продолжить» обязано получить
 * свою вводную, а не общее слово в закрытый разговор. У Claude вводная жила
 * только в памяти прогона (`continuationLink` теперь кладёт её в связь); у
 * чужого CLI реплика ложится в файл разговора ДО запуска процесса, разговор
 * группы переезжает на продолжение при старте, а ход без живой сессии собирает
 * промпт из всей переписки. Сборка настоящая (`createRuntime`), настоящий и
 * прогон чужого CLI (`ProviderChatRun`, одиночный запуск goose); подменён только
 * процесс CLI — по его argv видно, что модель получила бы.
 */

const PARENT = 'родитель-p24';
const TASK = 'SENTINEL_TASK PROJ-1 fix the export button';
const HANDOFF = 'SENTINEL_HANDOFF next: wire the export dialog';
const PROVIDER = 'goose';

const base: ChatLink = {
  parentChatId: PARENT,
  groupIndex: 0,
  branch: 'feature/g1',
  stage: 'work',
  createdAt: '2026-10-26T01:00:00.000Z',
};

interface Spawned {
  args: string[];
  child: EventEmitter & { kill: () => void };
}

describe('продолжение группы чужого CLI, оборванное паузой до первого хода (P-24)', () => {
  let root: string;
  let appData: string;
  let project: string;
  let store: AppStore;
  let runtime: Runtime;
  let spawned: Spawned[];
  let turns: string[];

  beforeEach(() => {
    root = realpathSync.native(mkdtempSync(join(tmpdir(), 'cc-rt-p24-')));
    appData = join(root, 'agentdeck');
    project = join(root, 'project');
    mkdirSync(appData, { recursive: true });
    mkdirSync(project);
    const git = (args: string): void => {
      execSync(`git ${args}`, { cwd: project, stdio: 'ignore' });
    };
    git('init -q -b main');
    git('-c user.email=p@x -c user.name=p commit -q --allow-empty -m base');
    git('checkout -q -b feature/g1');
    writeFileSync(join(root, 'settings.json'), '{}', 'utf8');
    writeFileSync(join(root, '.claude.json'), '{}', 'utf8');
    store = new AppStore(appData);
    const ctx = {
      store,
      location: {
        paths: {
          root,
          appData,
          settings: join(root, 'settings.json'),
          settingsLocal: join(root, 'settings.local.json'),
          claudeMd: join(root, 'CLAUDE.md'),
          secretsEnv: join(root, '.mcp-secrets.env'),
          skills: join(root, 'skills'),
          hooks: join(root, 'hooks'),
          mcpConfig: join(root, '.claude.json'),
        },
      },
      backupDir: join(root, 'backups'),
      pricing: { current: () => ({ entries: [] }) },
      models: { current: () => ({ models: [] }) },
    } as unknown as ServerContext;
    runtime = createRuntime(ctx, 'http://127.0.0.1:1');
    spawned = [];
    turns = [];

    // Процесс CLI — внешняя граница: argv записан, ответа нет, пока ход не сняли.
    const spawnImpl = ((_file: string, args: string[]) => {
      const child = new EventEmitter() as Spawned['child'] & {
        stdout: EventEmitter;
        stderr: EventEmitter;
        stdin: { write: () => void; end: () => void; on: () => void };
      };
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.stdin = { write: () => {}, end: () => {}, on: () => {} };
      child.kill = () => child.emit('close', null);
      spawned.push({ args, child });
      return child;
    }) as unknown as NonNullable<Parameters<ProviderChatRun['start']>[0]['spawnImpl']>;
    const native = { command: process.execPath, windowsCommand: process.execPath };

    (runtime.providerChats as unknown as { createRun: () => ProviderChatRunLike }).createRun =
      () => {
        const real = new ProviderChatRun();
        return {
          start: (options, onEvent) => {
            turns.push(options.chatId);
            // Первый ход работы закрывает этап блоком продолжения — так, как его
            // пишет агент; дальше — настоящий одиночный запуск goose.
            if (turns.length === 1) {
              mkdirSync(join(project, '.agent'), { recursive: true });
              writeFileSync(join(project, '.agent', 'PROGRESS.md'), 'progress', 'utf8');
              const proposal = {
                done: 'этап закрыт',
                next: HANDOFF,
                checkpoint: '.agent/PROGRESS.md',
              };
              onEvent({
                type: 'done',
                reply: [
                  'Готово.',
                  '',
                  '```' + HANDOFF_BLOCK_LANG,
                  JSON.stringify(proposal),
                  '```',
                ].join('\n'),
                transport: 'stream',
              });
              return Promise.resolve();
            }
            const provider = options.provider;
            return real.start(
              {
                ...options,
                provider: { ...provider, cli: { ...provider.cli, ...native } },
                spawnImpl,
                // CLI «установлен»: его процесс — подделка выше.
                detect: () => true,
              },
              onEvent,
            );
          },
          stop: () => real.stop(),
        };
      };
  });

  afterEach(async () => {
    for (const { child } of spawned) child.kill();
    runtime.chatRuns.stopAll();
    runtime.shutdown();
    await removeWhenFree(root);
  });

  const settle = () => new Promise((done) => setTimeout(done, 150));
  const promptOf = (at: number): string => spawned[at]?.args.at(-1) ?? '';

  it('«Продолжить» после паузы шлёт продолжению его вводную, а не общее слово прошлому разговору', async () => {
    const work = createChat(appData, PROVIDER, { title: 'G', workdir: project, allowEdits: true });
    const workKey = foreignChatKey(PROVIDER, work!.id);
    store.setChatLink(workKey, base);
    store.setSplitPlan({
      parentChatId: PARENT,
      projectPath: project,
      createdAt: '2026-10-26T00:00:00.000Z',
      order: [0],
      request: {},
      proposal: { groups: [{ title: 'G', tasks: ['PROJ-1'] }] },
      groups: [
        {
          index: 0,
          title: 'G',
          branch: 'feature/g1',
          after: [],
          status: 'started',
          chatId: workKey,
          path: project,
        },
      ],
    } as unknown as SplitPlanRecord);
    const provider = getProvider(PROVIDER);

    // Ход работы: агент закрыл этап блоком продолжения — панель заводит новый разговор.
    const sent = runtime.providerChats.send(
      appData,
      PROVIDER,
      work!.id,
      { text: TASK },
      { provider, models: [] },
    );
    expect(sent.ok).toBe(true);
    await settle();

    // Продолжение стартовало своей вводной — это уже настоящий процесс goose.
    expect(spawned).toHaveLength(1);
    expect(promptOf(0)).toContain(HANDOFF);
    const continuation = turns[1]!;
    expect(continuation).not.toBe(work!.id);
    const contKey = foreignChatKey(PROVIDER, continuation);
    expect(store.getSplitPlan(PARENT)?.groups[0]?.chatId).toBe(contKey);

    // Пауза группы через миг после передачи: ход продолжения снят до первого ответа.
    runtime.splitConveyor.pause(PARENT, 0);
    expect(runtime.providerChats.stop(continuation)).toBe(true);
    await settle();
    expect(store.getSplitPlan(PARENT)?.groups[0]?.status).toBe('paused');
    // Вводная пережила обрыв: она в файле разговора продолжения, а не в памяти прогона.
    const kept = readChat(appData, PROVIDER, continuation)?.messages ?? [];
    expect(
      kept.some((message) => message.role === 'user' && message.content.includes(HANDOFF)),
    ).toBe(true);

    // «Продолжить»: ход идёт в продолжение, и модель получает вводную вместе со словом.
    expect(runtime.splitConveyor.resumePaused(PARENT, 0, true)).toBe('sent');
    await settle();
    expect(turns[2]).toBe(continuation);
    expect(spawned).toHaveLength(2);
    expect(promptOf(1)).toContain(HANDOFF);
    // Закрытый разговор работы нового слова не получил.
    const closed = readChat(appData, PROVIDER, work!.id)?.messages ?? [];
    expect(closed.filter((message) => message.role === 'user')).toHaveLength(1);
  });
});
