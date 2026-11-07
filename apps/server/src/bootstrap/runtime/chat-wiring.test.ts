import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { Platform } from '@agentdeck/contracts';
import { defaultOurRules, defaultPlatformRules } from '@agentdeck/contracts/platform';
import { defaultPlatformTransport } from '@agentdeck/contracts/platform-transport';
import { AppStore } from '../../lib/app-store/app-store.ts';
import type { ServerContext } from '../../context.ts';
import { writePlatform } from '../../domains/platform/store/store.ts';
import { coreWithTurns } from '../../domains/chat/core-run/__fixtures__/core-with-turns.ts';
import { wireChat, type ChatWiring } from './chat-wiring.ts';

/**
 * Сборка чата панели (`wireChat`, W3-17a): маршрут контура хода — по галочке CLI РАЗГОВОРА
 * (Claude — «Чат», другой CLI — своя `foreign:<cli>`), CLI нового разговора — активный провайдер
 * из настроек, слой панели чужому CLI — `foreignCarry` от runtime. Настоящие: хранилище с активным
 * контуром, реестр прогонов, `CoreChatRun`, перевод галочки в набор маршрутов. Подменено только
 * ядро за HTTP (другой процесс): порт ядра отдаёт `coreWithTurns`, тест видит, что панель ему шлёт.
 */

const boundary = vi.hoisted(() => ({
  port: undefined as unknown,
}));
vi.mock('../../domains/chat/core-run/core-chat-port.ts', () => ({
  createCoreChatPort: () => boundary.port,
}));

const CONTOUR: Platform = {
  id: 'company',
  title: 'Company',
  driver: 'enterprise-platform',
  baseUrl: 'https://api.example.com',
  enabled: true,
  mode: 'best-effort',
  budgetUsd: 0,
  capabilities: [],
  targets: [],
  consumers: [],
  projectPaths: [],
  agents: [],
  budgetSince: '',
  toolShim: false,
  contourPrompt: false,
  defaultModel: 'corp-xl',
  consumerModels: {},
  modelMap: {},
  rules: { platform: defaultPlatformRules(), ours: defaultOurRules() },
  caCertPath: '',
  transport: defaultPlatformTransport(),
};

async function until(check: () => boolean, ms = 8000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check() && Date.now() < deadline) {
    await new Promise((done) => setTimeout(done, 20));
  }
}

let root: string;
let work: string;
let store: AppStore;
let core: ReturnType<typeof coreWithTurns>;
let wiring: ChatWiring | undefined;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'cc-chat-wiring-'));
  work = join(root, 'work');
  const appData = join(root, 'agentdeck');
  for (const dir of [work, appData]) mkdirSync(dir, { recursive: true });
  store = new AppStore(appData);
  core = coreWithTurns({ sessionId: 'wired-sess', answer: 'готов', turnAt: 1_793_989_152_846 });
  boundary.port = core.port;
});

afterEach(() => {
  wiring?.chatRuns.stopAll();
  wiring = undefined;
  rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

function contour(consumers: string[]): void {
  writePlatform(store, { ...CONTOUR, consumers });
  store.updateSettings({ activePlatformId: CONTOUR.id });
}

function wire(extra: Parameters<typeof wireChat>[1] = {}): ChatWiring {
  const ctx = {
    store,
    location: { paths: { root, appData: join(root, 'agentdeck') } },
  } as unknown as ServerContext;
  wiring = wireChat(ctx, extra);
  return wiring;
}

async function firstTurn(chats: ChatWiring): Promise<void> {
  expect(chats.chatRuns.start('new-wired-1', { prompt: 'Почини тест', cwd: work }, {})).toBe(true);
  await until(() => core.calls.some((call) => call.kind === 'launch'));
  expect(core.calls.map((call) => call.kind)).toContain('launch');
}

const routeCall = () => core.calls.find((call) => call.kind === 'set-route');

describe('wireChat: CLI разговора и галочка контура', () => {
  it('активен qwen, отмечена `foreign:qwen` — новый разговор идёт qwen через контур', async () => {
    store.updateSettings({ provider: 'qwen' });
    contour(['foreign:qwen']);
    await firstTurn(wire());

    expect(routeCall()?.fields).toMatchObject({
      allowedRoutes: [{ adapter: 'qwen', route: { kind: 'gateway', id: 'gateway:company' } }],
    });
    expect(core.calls.find((call) => call.kind === 'set-cli')?.fields).toMatchObject({
      adapter: 'qwen',
    });
  });

  it('активен qwen, отмечен только «Чат» — галочка Claude разговор qwen в контур не уводит', async () => {
    store.updateSettings({ provider: 'qwen' });
    contour(['chat']);
    await firstTurn(wire());

    expect(routeCall()).toBeUndefined();
  });

  it('активен Claude, отмечен «Чат» — разговор Claude через контур', async () => {
    store.updateSettings({ provider: 'claude' });
    contour(['chat']);
    await firstTurn(wire());

    expect(routeCall()?.fields).toMatchObject({
      allowedRoutes: [{ adapter: 'claude', route: { kind: 'gateway', id: 'gateway:company' } }],
    });
  });

  it('слой панели чужому CLI — `foreignCarry` из runtime, с CLI, каталогом и набором маршрутов', async () => {
    store.updateSettings({ provider: 'qwen' });
    contour(['foreign:qwen']);
    const foreignCarry = vi.fn(() => ({
      ok: true as const,
      carry: { session: {}, env: { WIRED_LAYER: '1' } },
    }));
    await firstTurn(wire({ foreignCarry }));

    expect(foreignCarry).toHaveBeenCalledWith(
      expect.objectContaining({
        cli: 'qwen',
        cwd: work,
        routes: [expect.objectContaining({ adapter: 'qwen' })],
      }),
    );
  });
});
