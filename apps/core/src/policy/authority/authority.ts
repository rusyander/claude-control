import type { CommandKind } from '@agentdeck/contracts/core/commands';
import type { JournalDataV1 } from '@agentdeck/contracts/core/journal';

/**
 * Кто вправе подать команду (06 §Authority, F23, P97). Решение — чистая функция по
 * доказательствам, собранным каналом: класс токена, одноразовое число страницы, пир-процесс и
 * подпись устройства. Ни один токен человека не доказывает (сессия может прочитать любой файл).
 *
 * - `human` — запуск, пауза, правка сценария…: число страницы + пир не из дерева сессии, или
 *   подпись устройства. Пир `unknown` с годным числом принимается — так в таблице 06.
 * - `human-strict` — ответ, одобрение, грант, публикация…: число + пир `clear`; пир `unknown` —
 *   только подпись устройства.
 * - Удалённая дорога (пир — демон Tailscale) и пересылка от непроверенного звена — только подпись.
 * - Токен сессии или пир из дерева сессии — отказ и сигнал `forged-authority`, даже с подписью.
 */

export type CommandProof = JournalDataV1['command.received']['proof'];

export type ProofClass = 'human' | 'human-strict';

export const COMMAND_PROOF_CLASS: Record<CommandKind, ProofClass> = {
  launch: 'human',
  pause: 'human',
  resume: 'human',
  cancel: 'human',
  'set-model': 'human',
  'set-cli': 'human',
  'set-route': 'human',
  'edit-scenario': 'human',
  'edit-split': 'human',
  'message-to-step': 'human',
  answer: 'human-strict',
  'approve-split': 'human-strict',
  grant: 'human-strict',
  'fresh-rerun': 'human-strict',
  'publish-now': 'human-strict',
  'release-resource': 'human-strict',
  'move-build': 'human-strict',
  'clean-remote': 'human-strict',
};

export type AuthorityDecision =
  | { allow: true; by: 'nonce+peer' | 'device-signature' }
  | { allow: false; code: AuthorityRefusal; reason: string; signal: 'forged-authority' | null };

export type AuthorityRefusal =
  | 'forged-authority'
  | 'proof-required'
  | 'nonce-invalid'
  | 'signature-invalid'
  | 'signature-required';

export function decideAuthority(kind: CommandKind, proof: CommandProof): AuthorityDecision {
  if (proof.token === 'session' || proof.peer === 'session-descendant') {
    return {
      allow: false,
      code: 'forged-authority',
      reason: 'command from a session token or a session-descendant process',
      signal: 'forged-authority',
    };
  }
  if (proof.token === 'none') {
    return { allow: false, code: 'proof-required', reason: 'no channel token', signal: null };
  }
  if (proof.signature === 'valid') return { allow: true, by: 'device-signature' };
  if (proof.signature === 'invalid') {
    return {
      allow: false,
      code: 'signature-invalid',
      reason: 'device signature not accepted',
      signal: null,
    };
  }
  const signatureOnly =
    proof.peer === 'remote' ||
    proof.peer === 'untrusted-forward' ||
    (proof.peer === 'unknown' && COMMAND_PROOF_CLASS[kind] === 'human-strict');
  if (signatureOnly) {
    return {
      allow: false,
      code: 'signature-required',
      reason: `peer ${proof.peer}: only a device signature proves a human for ${kind}`,
      signal: null,
    };
  }
  if (proof.nonce === 'valid') return { allow: true, by: 'nonce+peer' };
  if (proof.nonce === 'invalid') {
    return {
      allow: false,
      code: 'nonce-invalid',
      reason: 'nonce replayed, expired or from another page load',
      signal: null,
    };
  }
  return { allow: false, code: 'proof-required', reason: 'no human proof', signal: null };
}
