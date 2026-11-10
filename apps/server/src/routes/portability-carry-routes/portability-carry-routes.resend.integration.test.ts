import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { CarryApplyAnswer } from '@agentdeck/contracts/portable-carry';
import type { TaskView } from '@agentdeck/contracts/core/task-view';
import { AppStore } from '../../lib/app-store/app-store.ts';
import type { ServerContext } from '../../context.ts';
import { HandoffChains } from '../../domains/chat/ChatHandoff/ChatHandoff.ts';
import { createCoreChatBook } from '../../domains/chat/core-run/core-chat-book.ts';
import type { CoreChatBook } from '../../domains/chat/core-run/core-run.types.ts';
import { registerPortabilityCarryRoutes } from './portability-carry-routes.ts';

const SESSION = '01a1bb5b-9d0c-7c1e-8d1e-326836fc8f60';
const TASK = '01a1bb5b-9d0c-7c1e-8d1e-326836fc8f61';
const STEP = '01a1bb5b-9d0c-7c1e-8d1e-326836fc8f62';

/**
 * Перенос разговора, упёршегося в окно (этап 12, ревью, R6): «Перенести в X» — выбор человека,
 * где разговор продолжится. Задача ядра прежнего разговора, ждущая сброса окна, отменяется — иначе
 * после сброса она шлёт то же слово прежнему CLI ещё раз (лишний ответ, трата его окна).
 *
 * Хранилища настоящие (транскрипт Claude, опора, книга чата ядра на диске); подменены запуск прогона
 * у цели и ручки ядра (`view` / `command`) — внешняя граница процесса ядра.
 */
describe('portability-carry: перенос снимает повтор после сброса окна (R6)', () => {
  const savedEnv = { ...process.env };
  let home: string;
  let appData: string;
  let project: string;
  let app: FastifyInstance;
  let book: CoreChatBook;
  let startOk: boolean;
  let state: Pick<TaskView, 'state' | 'ended' | 'windowWait' | 'windows'>;
  const win = (verdict: TaskView['windows'][number]['verdict']): TaskView['windows'][number] => ({
    routeId: 'cli-login:claude',
    limitKind: 'window',
    verdict,
    resetAt: verdict === 'open' ? null : Date.now() + 60_000,
    seq: 1,
  });
  let commands: { taskId: string; kind: string; fields: Record<string, unknown> }[];

  beforeEach(async () => {
    home = mkdtempSync(join(tmpdir(), 'cc-carry-rs-home-'));
    appData = mkdtempSync(join(tmpdir(), 'cc-carry-rs-data-'));
    project = mkdtempSync(join(tmpdir(), 'cc-carry-rs-proj-'));
    for (const key of ['HOME', 'USERPROFILE']) process.env[key] = home;
    mkdirSync(join(project, '.agent'), { recursive: true });
    writeFileSync(join(project, '.agent', 'PROGRESS.md'), 'Состояние работы.\n', 'utf8');
    const dir = join(home, '.claude', 'projects', 'proj');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, `${SESSION}.jsonl`),
      `${JSON.stringify({
        type: 'user',
        uuid: 'u0',
        cwd: project,
        timestamp: new Date().toISOString(),
        message: { role: 'user', content: 'ход-1: привет' },
      })}\n`,
      'utf8',
    );
    book = createCoreChatBook(join(appData, 'core-chat-book.json'));
    book.set(SESSION, { taskId: TASK, stepId: STEP, cli: 'claude', cwd: project });
    startOk = true;
    state = { state: 'waiting-window', ended: null, windowWait: null, windows: [] };
    commands = [];

    const store = new AppStore(appData);
    store.updateSettings({ provider: 'codex' });
    app = Fastify();
    registerPortabilityCarryRoutes(
      app,
      {
        store,
        backupDir: join(appData, 'backups'),
        location: { paths: { appData, root: join(home, '.claude') } },
        models: { current: () => ({ models: [] }) },
      } as unknown as ServerContext,
      {
        chains: new HandoffChains(),
        runs: { start: () => startOk, emitExternal: () => false },
        session: { inherit: () => {}, autoModeOverride: () => undefined },
        coreChat: {
          book,
          port: {
            view: async (taskId: string) => (taskId === TASK ? { taskId, ...state } : null),
            command: async (taskId: string, kind: string, fields: Record<string, unknown>) => {
              commands.push({ taskId, kind, fields });
              return { cmdId: 'c1', status: 'applied', seq: 1 };
            },
          },
        },
      } as never,
    );
    await app.ready();
  });

  afterEach(async () => {
    await app?.close();
    for (const key of ['HOME', 'USERPROFILE']) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
    for (const dir of [home, appData, project]) rmSync(dir, { recursive: true, force: true });
  });

  async function apply(): Promise<CarryApplyAnswer> {
    const answer = await app.inject({
      method: 'POST',
      url: '/api/portability/carry/apply',
      payload: { keys: [SESSION] },
    });
    expect(answer.statusCode).toBe(200);
    return answer.json() as CarryApplyAnswer;
  }

  it('успешный перенос отменяет задачу, ждущую окно, с причиной в журнале; книга её забывает', async () => {
    const answer = await apply();

    expect(answer.outcomes[0]?.carried).toBe(true);
    expect(commands).toHaveLength(1);
    expect(commands[0]).toMatchObject({ taskId: TASK, kind: 'cancel' });
    expect(String(commands[0]?.fields.reason)).toContain('carried to codex');
    expect(book.get(SESSION)).toBeUndefined();
    expect(book.cliOf(SESSION)).toBe('claude');
  });

  it('перенос не случился — повтор после сброса остаётся', async () => {
    startOk = false;

    const answer = await apply();

    expect(answer.outcomes[0]?.carried).toBe(false);
    expect(commands).toEqual([]);
    expect(book.get(SESSION)).toEqual({ taskId: TASK, stepId: STEP });
  });

  it('ход только что упёрся в отказ окна, задача ещё running — перенос её отменяет', async () => {
    // Живой стенд: карточка лимита видна по ленте раньше, чем ядро переводит задачу в ожидание.
    state = { state: 'running', ended: null, windowWait: null, windows: [win('refused')] };

    await apply();

    expect(commands.map((c) => c.kind)).toEqual(['cancel']);
    expect(book.get(SESSION)).toBeUndefined();
  });

  it('повтора впереди нет (окно открыто или задача кончилась) — перенос её не трогает', async () => {
    state = { state: 'running', ended: null, windowWait: null, windows: [win('open')] };
    await apply();
    state = { state: 'cancelled', ended: 'cancelled', windowWait: null, windows: [win('refused')] };
    await apply();

    expect(commands).toEqual([]);
    expect(book.get(SESSION)).toEqual({ taskId: TASK, stepId: STEP });
  });
});
