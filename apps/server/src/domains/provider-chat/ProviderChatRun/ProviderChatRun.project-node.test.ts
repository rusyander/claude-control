import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { delimiter, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { getProvider } from '../../../providers/registry.ts';
import { resetChatNodeCache, type ChatNodeDeps } from '../../project-git/chat-node.ts';
import type { LiveTurn, LiveTurnOptions, LiveTurnResult } from '../live/types.ts';
import { ProviderChatRun } from './ProviderChatRun.ts';

/**
 * Node проекта первым в PATH чужого CLI (P-32), как у Claude (`ChatRunner` → `withChatNode`):
 * группа Qwen/Codex шла на Node по умолчанию, проект просил 22 — гейт отказывал проверкой
 * движка. Настоящие `withChatNode`, чтение `.nvmrc` с диска и сборка окружения прогона;
 * подменены только процесс CLI / живой ход и список Node на машине (внешняя граница).
 */

const ROOT = resolve('/');
const NODE22 = join(ROOT, 'nvm', 'v22.23.2');

const nodes: ChatNodeDeps = {
  defaultNode: () => 'v24.13.0',
  installed: () => [
    { version: [22, 23, 2], text: '22.23.2', dir: NODE22, manager: 'nvm-windows' },
    { version: [24, 13, 0], text: '24.13.0', dir: join(ROOT, 'nvm', 'v24.13.0'), manager: 'nvm' },
  ],
  exists: () => false,
  realpath: (path) => path,
  now: () => 0,
};

const pathOf = (env: NodeJS.ProcessEnv | Record<string, string> | undefined): string =>
  Object.entries(env ?? {}).find(([key]) => key.toLowerCase() === 'path')?.[1] ?? '';
const serverPath = pathOf(process.env);

function fakeSpawn(seen: (NodeJS.ProcessEnv | undefined)[]) {
  return ((_file: string, _args: string[], options: { env?: NodeJS.ProcessEnv }) => {
    seen.push(options?.env);
    const child = new EventEmitter() as EventEmitter & Record<string, unknown>;
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stdin = { write: () => {}, end: () => {}, on: () => {} };
    child.kill = () => child.emit('close', null);
    setTimeout(() => child.emit('close', 0), 0);
    return child;
  }) as unknown as LiveTurnOptions['spawnImpl'];
}

class SeenTurn implements LiveTurn {
  seen?: LiveTurnOptions;
  run(options: LiveTurnOptions): Promise<LiveTurnResult> {
    this.seen = options;
    return Promise.resolve({ kind: 'done', reply: 'ок' });
  }
  async steer(): Promise<boolean> {
    return false;
  }
  stop(): void {}
}

describe('ProviderChatRun: Node проекта первым в PATH чужого CLI (P-32)', () => {
  let dir: string;
  let project: string;
  beforeEach(() => {
    resetChatNodeCache();
    dir = mkdtempSync(join(tmpdir(), 'cc-pchat-node-'));
    project = mkdtempSync(join(tmpdir(), 'cc-pchat-node-proj-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    rmSync(project, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  const history = [
    { id: 'm1', role: 'user' as const, content: 'Вопрос', at: '2026-01-01T00:00:00.000Z' },
  ];

  async function oneShot(platformEnv?: Record<string, string>) {
    const seen: (NodeJS.ProcessEnv | undefined)[] = [];
    const goose = getProvider('goose');
    // Нативный исполняемый файл: запуск не зависит от того, как стоит goose.
    const native = { command: process.execPath, windowsCommand: process.execPath };
    await new ProviderChatRun().start(
      {
        provider: { ...goose, cli: { ...goose.cli, ...native } },
        history,
        chatId: 'chat',
        appDataDir: dir,
        workdir: project,
        detect: () => true,
        spawnImpl: fakeSpawn(seen),
        chatNodeDeps: nodes,
        ...(platformEnv ? { platformEnv } : {}),
      } as Parameters<ProviderChatRun['start']>[0],
      () => undefined,
    );
    return seen;
  }

  it('одиночный запуск: проект просит 22, по умолчанию 24 — каталог 22 первым, PATH сервера за ним', async () => {
    writeFileSync(join(project, '.nvmrc'), '22\n');
    const [env] = await oneShot({ AGENTDECK_GROUP_STAGE: 'work' });
    expect(pathOf(env)).toBe(`${NODE22}${delimiter}${serverPath}`);
    // Остальное окружение прогона на месте: добавка, а не замена.
    expect(env?.AGENTDECK_GROUP_STAGE).toBe('work');
    expect(env?.PWD).toBe(project);
  });

  it('одиночный запуск без требования версии — PATH сервера как есть', async () => {
    const [env] = await oneShot();
    expect(pathOf(env)).toBe(serverPath);
  });

  it('живой ход (Qwen): тот же Node проекта в окружении хода, окружение прогона сохранено', async () => {
    writeFileSync(join(project, '.nvmrc'), '22\n');
    const turn = new SeenTurn();
    await new ProviderChatRun().start(
      {
        provider: getProvider('qwen'),
        history,
        chatId: 'chat',
        appDataDir: dir,
        workdir: project,
        detect: () => true,
        liveTurn: () => turn,
        chatNodeDeps: nodes,
        platformEnv: { AGENTDECK_GROUP_STAGE: 'work' },
        optionalEnvKeys: ['AGENTDECK_GROUP_STAGE'],
      } as Parameters<ProviderChatRun['start']>[0],
      () => undefined,
    );
    expect(turn.seen).toBeDefined();
    expect(pathOf(turn.seen?.env)).toBe(`${NODE22}${delimiter}${serverPath}`);
    expect(turn.seen?.env?.AGENTDECK_GROUP_STAGE).toBe('work');
    // Добавка, а не копия окружения сервера: ход несёт только свои ключи и путь.
    expect(Object.keys(turn.seen?.env ?? {}).map((key) => key.toLowerCase())).toEqual([
      'agentdeck_group_stage',
      'path',
    ]);
  });

  it('живой ход без требования версии — окружения хода нет, как было', async () => {
    const turn = new SeenTurn();
    await new ProviderChatRun().start(
      {
        provider: getProvider('qwen'),
        history,
        chatId: 'chat',
        appDataDir: dir,
        workdir: project,
        detect: () => true,
        liveTurn: () => turn,
        chatNodeDeps: nodes,
      } as Parameters<ProviderChatRun['start']>[0],
      () => undefined,
    );
    expect(turn.seen).toBeDefined();
    expect(turn.seen?.env).toBeUndefined();
  });
});
