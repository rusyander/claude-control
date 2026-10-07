import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { ProviderChatProject, ProviderChatSummary } from '@agentdeck/contracts';
import { AppStore } from '../lib/app-store.ts';
import type { ServerContext } from '../context.ts';
import { ProviderChatService } from '../domains/provider-chat.ts';
import { HandoffChains } from '../domains/chat/ChatHandoff.ts';
import { registerProviderChatRoutes } from './provider-chat-routes.ts';

/**
 * `GET /api/provider-chat/projects`: проекты Claude (из его транскриптов) и
 * чужих CLI (из разговоров панели) одним списком. Настоящий `~/.claude` и
 * каталоги CLI не трогаются: и транскрипт, и разговор лежат во временном
 * каталоге, ровно в тех местах, где их ищут боевые модули.
 */

/** Строка транскрипта Claude: рабочий каталог сессии берётся из `cwd`. */
function claudeTranscript(root: string, dir: string, cwd: string, at: string): void {
  mkdirSync(join(root, 'projects', dir), { recursive: true });
  const file = join(root, 'projects', dir, `${dir}-sess.jsonl`);
  writeFileSync(
    file,
    `${JSON.stringify({
      type: 'user',
      uuid: `u-${dir}`,
      timestamp: at,
      cwd,
      message: { role: 'user', content: 'привет' },
    })}\n`,
  );
  // Свежесть разговора Claude читается по времени файла, а не по записи внутри.
  utimesSync(file, new Date(at), new Date(at));
}

/** Разговор чужого CLI в формате панели — шапка и одна реплика. */
function foreignChat(
  appData: string,
  providerId: string,
  id: string,
  workdir: string | undefined,
  at: string,
): void {
  const dir = join(appData, 'provider-chats', providerId);
  mkdirSync(dir, { recursive: true });
  const meta = {
    kind: 'meta',
    id,
    providerId,
    title: id,
    createdAt: at,
    ...(workdir ? { workdir } : {}),
  };
  const message = { kind: 'message', id: `${id}-m`, role: 'user', content: 'x', at };
  writeFileSync(join(dir, `${id}.jsonl`), `${JSON.stringify(meta)}\n${JSON.stringify(message)}\n`);
}

describe('GET /api/provider-chat/projects', () => {
  let root: string;
  let project: string;
  let app: FastifyInstance;
  let chats: ProviderChatService;

  const appData = (): string => join(root, 'agentdeck');

  const boot = async (provider: string): Promise<void> => {
    const store = new AppStore(appData());
    store.updateSettings({ provider });
    const ctx = {
      location: { paths: { root, appData: appData() } },
      store,
      models: { current: () => ({ models: [] }) },
      backupDir: join(appData(), 'backups'),
    } as unknown as ServerContext;
    app = Fastify();
    chats = new ProviderChatService(() => {
      throw new Error('прогон в этом тесте не запускается');
    });
    registerProviderChatRoutes(app, ctx, chats, new HandoffChains());
    await app.ready();
  };

  const list = async (): Promise<ProviderChatProject[]> => {
    const res = await app.inject({ method: 'GET', url: '/api/provider-chat/projects' });
    expect(res.statusCode).toBe(200);
    return res.json<ProviderChatProject[]>();
  };

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'cc-pprojects-'));
    project = mkdtempSync(join(tmpdir(), 'cc-pprojects-repo-'));
    mkdirSync(appData(), { recursive: true });
  });

  afterEach(async () => {
    chats?.stopAll();
    await app?.close();
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    rmSync(project, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  it('каталог Claude и тот же каталог у Codex — одна строка с обоими провайдерами', async () => {
    claudeTranscript(root, 'enc-a', project, '2026-10-01T10:00:00.000Z');
    // Тот же каталог другим написанием: хвостовой разделитель (и регистр на Windows).
    const spelled = `${process.platform === 'win32' ? project.toUpperCase() : project}/`;
    foreignChat(appData(), 'codex', 'c1', spelled, '2026-10-02T10:00:00.000Z');
    await boot('kimi');

    const projects = await list();

    expect(projects).toHaveLength(1);
    expect(projects[0]?.providers.map((provider) => provider.id)).toEqual(['codex', 'claude']);
    expect(projects[0]?.providers.find((provider) => provider.id === 'claude')).toMatchObject({
      name: 'Claude Code',
      chatCount: 1,
    });
    expect(projects[0]?.lastActivity).toBe('2026-10-02T10:00:00.000Z');
    expect(projects[0]).not.toHaveProperty('startProblem');
  });

  it('исчезнувший каталог остаётся в списке с причиной, разговор без каталога проектом не считается', async () => {
    const gone = join(root, 'gone-project');
    claudeTranscript(root, 'enc-gone', gone, '2026-10-01T10:00:00.000Z');
    foreignChat(appData(), 'qwen', 'q1', undefined, '2026-10-03T10:00:00.000Z');
    await boot('qwen');

    const projects = await list();

    expect(projects).toHaveLength(1);
    expect(projects[0]).toMatchObject({ path: gone, startProblem: 'missing' });
  });

  it('новый разговор активного провайдера в каталоге проекта Claude добавляет его бейдж', async () => {
    claudeTranscript(root, 'enc-a', project, '2026-10-01T10:00:00.000Z');
    await boot('qwen');

    const before = await list();
    expect(before[0]?.providers.map((provider) => provider.id)).toEqual(['claude']);

    const created = await app.inject({
      method: 'POST',
      url: '/api/provider-chat/chats',
      payload: { workdir: before[0]?.path },
    });
    expect(created.statusCode).toBe(200);
    expect(created.json<ProviderChatSummary>().workdir).toBe(project);

    const after = await list();
    expect(after).toHaveLength(1);
    expect(after[0]?.providers.map((provider) => provider.id).sort()).toEqual(['claude', 'qwen']);
  });
});
