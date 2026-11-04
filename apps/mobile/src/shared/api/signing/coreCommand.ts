import { ed25519 } from '@noble/curves/ed25519.js';
import type { CommandEnvelope } from '@agentdeck/contracts/core/commands';
import {
  buildSignedMessage,
  formatSignatureHeader,
  signedPayloadText,
  toBase64Url,
  utf8Bytes,
} from '@agentdeck/contracts/phone-signing';
import { sha256Hex, wireBody, type PhoneKey } from './signing';

/**
 * Подпись команды ядру задач ключом телефона (06 §Authority (b)). Команда ядра несёт подпись
 * в ТЕЛЕ (`proof.signature`), а не заголовком панели: ядро проверяет её само над своим адресом
 * `POST /v1/commands` и конвертом без `proof` (`apps/core/src/api/auth.ts`, `signedBody`).
 * Номер машины — панели (`/api/system`): ядро принимает его при переносе устройств
 * (`adopt-devices`), поэтому одна подпись годится и панели, и ядру за ней.
 *
 * Ответ на вопрос — `human-strict`: с телефона (пир — не процесс этой машины) ядро принимает
 * только подпись устройства, число страницы ему не доказательство.
 */

export const CORE_COMMANDS_ROUTE = 'POST /v1/commands';

export type UnsignedCoreCommand = Omit<CommandEnvelope, 'proof'>;

export interface CoreSignInput {
  key: PhoneKey;
  /** Номер машины панели, к которой спарен телефон. */
  panel: string;
  command: UnsignedCoreCommand;
  nonce: string;
  time: number;
}

/** Строка `proof.signature` для конверта команды. */
export function coreCommandSignature(input: CoreSignInput): string {
  const message = buildSignedMessage({
    panel: input.panel,
    device: input.key.deviceId,
    route: CORE_COMMANDS_ROUTE,
    payloadHash: sha256Hex(signedPayloadText({}, wireBody(input.command))),
    nonce: input.nonce,
    time: input.time,
  });
  const sig = toBase64Url(ed25519.sign(utf8Bytes(message), input.key.seed));
  return formatSignatureHeader({
    device: input.key.deviceId,
    nonce: input.nonce,
    time: input.time,
    sig,
  });
}

/** Конверт целиком: подпись в `proof`, остальное — как подписано. */
export function signedCoreCommand(input: CoreSignInput): CommandEnvelope {
  return { ...input.command, proof: { signature: coreCommandSignature(input) } };
}
