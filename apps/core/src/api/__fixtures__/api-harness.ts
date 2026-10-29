import { generateKeyPairSync, sign, type KeyObject } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { CommandEnvelope, CommandKind } from '@agentdeck/contracts/core/commands';
import {
  buildSignedMessage,
  deviceIdOf,
  formatSignatureHeader,
  signedPayloadText,
  toBase64Url,
  utf8Bytes,
} from '@agentdeck/contracts/phone-signing';
import { createTaskRegistry, type TaskRegistry } from '../../conductor/tasks.ts';
import { CREATED, deps, fakeClock, tempDir } from '../../journal/__fixtures__/journal-harness.ts';
import { newId } from '../../lib/ids/uuidv7.ts';
import { createNonceStore, type NonceStore } from '../../policy/authority/nonce.ts';
import {
  publicKeyHash,
  sha256Hex,
  type SigningDevice,
} from '../../policy/authority/device-signature.ts';
import { signedBody, type PeerDeps } from '../auth.ts';
import { buildApi } from '../server.ts';

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

export async function startStand(tasksDir = tempDir('api-')): Promise<Stand> {
  const clock = fakeClock();
  const registry = createTaskRegistry(tasksDir, deps({ clock }));
  const task = await registry.create(CREATED);
  const nonces = createNonceStore();
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
      home: tasksDir,
    },
    now: Date.now,
    pingMs: 60_000,
  });
  await app.listen({ host: '127.0.0.1', port: 0 });
  const url = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  const auth = (token?: string): Record<string, string> =>
    token ? { authorization: `Bearer ${token}` } : {};
  const stand: Stand = {
    url,
    clock,
    registry,
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
