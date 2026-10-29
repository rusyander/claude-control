import type { IncomingMessage } from 'node:http';
import { isUuidv7 } from '@agentdeck/contracts/core/ids';
import { SIGNATURE_NONCE_TTL_MS } from '@agentdeck/contracts/phone-signing';
import type { CommandEnvelope } from '@agentdeck/contracts/core/commands';
import { tokenEquals } from '../platform/token-file.ts';
import type { CommandProof } from '../policy/authority/authority.ts';
import type { NonceStore } from '../policy/authority/nonce.ts';
import { verifyDeviceSignature, type SigningDevice } from '../policy/authority/device-signature.ts';

/**
 * Канал API ядра: какой токен пришёл и что известно о процессе-звонящем (06 §Authority).
 * Токен открывает чтение; человека он не доказывает. Доказательство команды собирается здесь
 * (число страницы, пир, подпись) и судится одной функцией `policy/authority`.
 */

export type TokenClass = CommandProof['token'];

export interface TokenSources {
  /** `<core home>/token` — панельный сервер → ядро. */
  core: string;
  /** Bearer удалённой дороги панели, если ядру его показали (только чтение файла). */
  panelBearer?: string;
  /** Токены сессий (03): их предъявитель — модель, а не человек. */
  isSessionToken?: (token: string) => boolean;
}

export function bearerOf(header: string | string[] | undefined): string | undefined {
  const raw = Array.isArray(header) ? header[0] : header;
  const match = /^Bearer\s+(\S+)$/i.exec(raw ?? '');
  return match?.[1];
}

export function classifyToken(
  header: string | string[] | undefined,
  sources: TokenSources,
): TokenClass {
  const token = bearerOf(header);
  if (!token) return 'none';
  if (tokenEquals(sources.core, token)) return 'core';
  if (sources.panelBearer && tokenEquals(sources.panelBearer, token)) return 'panel-bearer';
  if (sources.isSessionToken?.(token)) return 'session';
  return 'none';
}

export type PeerClass = CommandProof['peer'];

export interface PeerDeps {
  /** pid процесса на том конце loopback-соединения (платформа: `peer-pid`). */
  peerPid(query: {
    serverPort: number;
    clientPort: number;
    /** Оба адреса сокета и pid ядра: по одним портам чужая строка дала бы чужой pid (F-16). */
    serverAddress?: string;
    clientAddress?: string;
    serverPid?: number;
  }): Promise<{ value: number } | { absent: true } | { unknown: string }>;
  /** Входит ли pid в дерево любой сессии (живой снимок + журнальные наборы потомков, 03). */
  isSessionDescendant(pid: number): Promise<boolean | 'unknown'>;
  /** pid звеньев, которым разрешено пересылать pid пира (их записал надзор при загрузке). */
  trustedHopPids: ReadonlySet<number>;
}

export const FORWARDED_PEER_HEADER = 'x-agentdeck-peer-pid';

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

export async function classifyPeer(request: IncomingMessage, deps: PeerDeps): Promise<PeerClass> {
  const socket = request.socket;
  if (!socket.remoteAddress || !LOOPBACK.has(socket.remoteAddress)) return 'remote';
  if (!socket.localPort || !socket.remotePort) return 'unknown';
  // Строка таблицы сверяется по обоим концам соединения и по владельцу серверной половины —
  // API работает в процессе ядра, его pid и есть сервер (ревью F-16).
  const direct = await deps.peerPid({
    serverPort: socket.localPort,
    clientPort: socket.remotePort,
    ...(socket.localAddress ? { serverAddress: socket.localAddress } : {}),
    clientAddress: socket.remoteAddress,
    serverPid: process.pid,
  });
  if (!('value' in direct)) return 'unknown';
  let pid = direct.value;
  const forwarded = request.headers[FORWARDED_PEER_HEADER];
  // Звено пересылки без заголовка — источник не назван: pid самого звена (панельный сервер) не
  // из сессии и дал бы `clear`, то есть «человек» для любого, кто дошёл через звено. Пир
  // неизвестен — строгая команда требует подписи устройства (W2-C, вопрос A).
  if (forwarded === undefined && deps.trustedHopPids.has(direct.value)) return 'unknown';
  if (forwarded !== undefined) {
    // Пересылать pid вправе только звено, чей собственный pid записан надзором.
    if (!deps.trustedHopPids.has(direct.value)) return 'untrusted-forward';
    const claimed = Number(Array.isArray(forwarded) ? forwarded[0] : forwarded);
    if (!Number.isInteger(claimed) || claimed <= 0) return 'untrusted-forward';
    pid = claimed;
  }
  const inSession = await deps.isSessionDescendant(pid);
  if (inSession === 'unknown') return 'unknown';
  return inSession ? 'session-descendant' : 'clear';
}

export interface SignatureDeps {
  machineId: string;
  devices(): readonly SigningDevice[];
  now(): number;
}

/** Номера подписей устройства, уже принятые: повтор подписи — `invalid`. */
export function createSeenSignatures(now: () => number): { claim(key: string): boolean } {
  const seen = new Map<string, number>();
  return {
    claim(key) {
      const at = now();
      for (const [k, exp] of seen) if (exp <= at) seen.delete(k);
      if (seen.has(key)) return false;
      seen.set(key, at + SIGNATURE_NONCE_TTL_MS);
      return true;
    },
  };
}

/** Тело, которое подписывает устройство: конверт команды без самого доказательства. */
export function signedBody(command: CommandEnvelope): unknown {
  const { proof: _proof, ...rest } = command;
  return rest;
}

export async function gatherProof(opts: {
  request: IncomingMessage;
  command: CommandEnvelope;
  token: TokenClass;
  nonces: NonceStore;
  peer: PeerDeps;
  signature: SignatureDeps;
  seen: { claim(key: string): boolean };
}): Promise<CommandProof> {
  const { command } = opts;
  const page = command.proof.page;
  const nonce = opts.nonces.consume(command.proof.nonce, page && isUuidv7(page) ? page : undefined);
  const peer = await classifyPeer(opts.request, opts.peer);
  let signature: CommandProof['signature'] = 'absent';
  if (command.proof.signature !== undefined) {
    const checked = verifyDeviceSignature(
      {
        route: 'POST /v1/commands',
        params: {},
        body: signedBody(command),
        header: command.proof.signature,
      },
      {
        machineId: opts.signature.machineId,
        now: opts.signature.now(),
        devices: opts.signature.devices(),
      },
    );
    signature =
      checked.ok && opts.seen.claim(`${checked.deviceId}:${checked.nonce}`) ? 'valid' : 'invalid';
  }
  return { token: opts.token, nonce, peer, signature };
}
