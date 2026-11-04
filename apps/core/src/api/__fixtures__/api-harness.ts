import { generateKeyPairSync, sign, type KeyObject } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { dirname } from 'node:path';
import type { CommandEnvelope, CommandKind } from '@agentdeck/contracts/core/commands';
import {
  buildSignedMessage,
  deviceIdOf,
  formatSignatureHeader,
  signedPayloadText,
  toBase64Url,
  utf8Bytes,
} from '@agentdeck/contracts/phone-signing';
import type { SplitEnv } from '../../conductor/estimate/index.ts';
import { createTaskRegistry, type TaskRegistry } from '../../conductor/tasks.ts';
import { CREATED, deps, fakeClock, tempDir } from '../../journal/__fixtures__/journal-harness.ts';
import { newId } from '../../lib/ids/uuidv7.ts';
import { layoutOf, type CoreHomeLayout } from '../../platform/core-home.ts';
import { ensureDir } from '../../platform/safe-io/files.ts';
import { createNonceStore, type NonceStore } from '../../policy/authority/nonce.ts';
import {
  publicKeyHash,
  sha256Hex,
  type SigningDevice,
} from '../../policy/authority/device-signature.ts';
import { WindowBook } from '../../economy/window/index.ts';
import { signedBody, type PeerDeps } from '../auth.ts';
import type { ConfigPort } from '../config.types.ts';
import { buildApi, type ApiDeps } from '../server.ts';

/**
 * Стенд API ядра для тестов: настоящий Fastify на 127.0.0.1 со случайным портом, настоящий
 * журнал в песочнице, настоящий ключ Ed25519 устройства. Подменён только пир-процесс: тест
 * сам говорит, какой pid стоит на том конце и входит ли он в дерево сессии.
 */

export const TOKENS = {
  core: 'core-token-0123456789',
  panel: 'panel-token-0123456789',
  session: 'session-token-0123',
};
export const MACHINE_ID = 'machine-test';
export const DIRECT_PID = 4242;
export const TRUSTED_HOP_PID = 7777;
export const SESSION_PID = 6666;

export interface Device {
  device: SigningDevice;
  signFor(
    command: Omit<CommandEnvelope, 'proof'> & { proof?: CommandEnvelope['proof'] },
    nonce?: string,
    time?: number,
  ): string;
}

export function makeDevice(): Device {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const x = (publicKey.export({ format: 'jwk' }) as { x: string }).x;
  const id = deviceIdOf(publicKeyHash(x) ?? '');
  return {
    device: { id, publicKey: x },
    signFor(command, nonce = newId().replace(/-/g, ''), time = Date.now()) {
      return header(privateKey as KeyObject, id, command as CommandEnvelope, nonce, time);
    },
  };
}

function header(
  key: KeyObject,
  device: string,
  command: CommandEnvelope,
  nonce: string,
  time: number,
): string {
  const message = buildSignedMessage({
    panel: MACHINE_ID,
    device,
    route: 'POST /v1/commands',
    payloadHash: sha256Hex(signedPayloadText({}, signedBody({ ...command, proof: {} }))),
    nonce,
    time,
  });
  const sig = toBase64Url(new Uint8Array(sign(null, utf8Bytes(message), key)));
  return formatSignatureHeader({ device, nonce, time, sig });
}

export interface Stand {
  url: string;
  /** Часы журнала задач стенда — тесты двигают их сами. */
  clock: ReturnType<typeof fakeClock>;
  registry: TaskRegistry;
  /** Дом ядра стенда: задачи в `layout.tasks`, библиотека сценариев — `layout.scenarios`. */
  layout: CoreHomeLayout;
  /** Книга окон, которую читает `/v1/health`: тест кладёт в неё факт предела. */
  windows: WindowBook;
  /** Отдать API среду деления (как загрузка после `startConductor`); `undefined` — дирижёра нет. */
  setSplit(env: SplitEnv | undefined): void;
  nonces: NonceStore;
  taskId: string;
  device: Device;
  peer: { direct: number | 'unknown'; sessionPids: Set<number>; delayMs: number };
  get(path: string, token?: string, headers?: Record<string, string>): Promise<Response>;
  command(
    body: unknown,
    opts?: { token?: string; headers?: Record<string, string> },
  ): Promise<{ status: number; body: Record<string, unknown> }>;
  envelope(kind: CommandKind, fields?: unknown, extra?: Partial<CommandEnvelope>): CommandEnvelope;
  nonce(page?: string): Promise<{ nonce: string; page: string }>;
  close(): Promise<void>;
}

/**
 * Перезапуск передаёт каталог задач прежнего стенда — дом тот же, `<дом>/tasks`. `config` — порт
 * настройки ядра (этап 7): без него `/v1/config` отвечает 501, как у загрузки без зоны настройки.
 */
export async function startStand(
  tasksDir?: string,
  opts: {
    config?: () => ConfigPort | undefined;
    routes?: ApiDeps['routes'];
    devices?: ApiDeps['devices'];
    adapters?: ApiDeps['adapters'];
    ask?: ApiDeps['ask'];
    reviewLink?: ApiDeps['reviewLink'];
    mcpOffers?: ApiDeps['mcpOffers'];
  } = {},
): Promise<Stand> {
  const layout = layoutOf(tasksDir ? dirname(tasksDir) : tempDir('api-'));
  ensureDir(layout.tasks);
  const clock = fakeClock();
  const registry = createTaskRegistry(layout.tasks, deps({ clock }));
  // Дирижёра у стенда нет: оценка и запуск отказывают «не подключено», пока тест не отдаст среду.
  let split: SplitEnv | undefined;
  const task = await registry.create(CREATED);
  const nonces = createNonceStore();
  const windows = new WindowBook();
  const device = makeDevice();
  const peer = {
    direct: DIRECT_PID as number | 'unknown',
    sessionPids: new Set([SESSION_PID]),
    delayMs: 0,
  };
  const peerDeps: PeerDeps = {
    // Настоящее чтение таблицы TCP идёт сотни миллисекунд; задержка делает гонку команд видимой.
    peerPid: async () => {
      if (peer.delayMs) await new Promise((r) => setTimeout(r, peer.delayMs));
      return peer.direct === 'unknown' ? { unknown: 'table read failed' } : { value: peer.direct };
    },
    isSessionDescendant: async (pid) => peer.sessionPids.has(pid),
    trustedHopPids: new Set([TRUSTED_HOP_PID]),
  };
  const app = buildApi({
    registry,
    env: { layout, split: () => split },
    tokens: {
      core: TOKENS.core,
      panelBearer: TOKENS.panel,
      isSessionToken: (t) => t === TOKENS.session,
    },
    nonces,
    peer: peerDeps,
    signature: { machineId: MACHINE_ID, devices: () => [device.device], now: Date.now },
    health: {
      build: 'test',
      bootId: newId(),
      pid: process.pid,
      startedAt: Date.now(),
      home: layout.root,
    },
    windows,
    now: Date.now,
    pingMs: 60_000,
    ...(opts.config ? { config: opts.config } : {}),
    ...(opts.routes ? { routes: opts.routes } : {}),
    ...(opts.devices ? { devices: opts.devices } : {}),
    ...(opts.adapters ? { adapters: opts.adapters } : {}),
    ...(opts.mcpOffers ? { mcpOffers: opts.mcpOffers } : {}),
    ...(opts.ask ? { ask: opts.ask } : {}),
    ...(opts.reviewLink ? { reviewLink: opts.reviewLink } : {}),
  });
  await app.listen({ host: '127.0.0.1', port: 0 });
  const url = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  const auth = (token?: string): Record<string, string> =>
    token ? { authorization: `Bearer ${token}` } : {};
  const stand: Stand = {
    url,
    clock,
    registry,
    layout,
    windows,
    setSplit(env) {
      split = env;
    },
    nonces,
    taskId: task.taskId,
    device,
    peer,
    get: (path, token = TOKENS.core, headers = {}) =>
      fetch(`${url}${path}`, { headers: { ...auth(token), ...headers } }),
    async command(body, opts = {}) {
      const res = await fetch(`${url}/v1/commands`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...auth(opts.token ?? TOKENS.core),
          ...(opts.headers ?? {}),
        },
        body: JSON.stringify(body),
      });
      return { status: res.status, body: (await res.json()) as Record<string, unknown> };
    },
    envelope(kind, fields = {}, extra = {}) {
      return {
        cmdId: newId(),
        kind,
        target: { taskId: task.taskId },
        fields: fields as never,
        proof: {},
        ...extra,
      };
    },
    async nonce(page = newId()) {
      const res = await stand.get(`/v1/nonce?page=${page}`);
      const body = (await res.json()) as { nonce: string };
      return { nonce: body.nonce, page };
    },
    async close() {
      await app.close();
      registry.closeAll();
    },
  };
  return stand;
}
