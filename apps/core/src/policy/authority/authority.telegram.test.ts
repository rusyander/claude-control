import type { AuthorityKind } from '@agentdeck/contracts/core/commands';
import { describe, expect, it } from 'vitest';
import { COMMAND_PROOF_CLASS, decideAuthority, type CommandProof } from './authority.ts';

/**
 * Пир `telegram` × каждый вид команды (этап 12, D29, P187, critic M4): проходят ровно восемь видов,
 * которые шлёт бот, — отмена, доработка, смена модели и CLI, ход доски, запись во «Входящие»,
 * ответ и одобрение деления. Всё прочее (`grant`, `set-config`, `take-over`, `publish-now`…) —
 * `signature-required`: шире панели Telegram не открывает ничего.
 */

const ALLOWED: readonly AuthorityKind[] = [
  'cancel',
  'rework',
  'set-model',
  'set-cli',
  'board-move',
  'inbox-create',
  'answer',
  'approve-split',
];

const telegram: CommandProof = {
  token: 'core',
  nonce: 'valid',
  peer: 'telegram',
  signature: 'absent',
};

describe('decideAuthority: peer telegram (stage 12, D29, P187)', () => {
  it('every authority kind: exactly the eight Telegram kinds pass, the rest need a device signature', () => {
    const kinds = Object.keys(COMMAND_PROOF_CLASS) as AuthorityKind[];
    const passed = kinds.filter((kind) => decideAuthority(kind, telegram).allow);
    expect(passed.sort()).toEqual([...ALLOWED].sort());
    for (const kind of kinds.filter((k) => !ALLOWED.includes(k))) {
      expect(decideAuthority(kind, telegram)).toMatchObject({
        allow: false,
        code: 'signature-required',
      });
    }
    // Ключевые запреты названы поимённо: грант, настройка, перехват, публикация.
    for (const kind of ['grant', 'set-config', 'take-over', 'publish-now', 'set-route'] as const) {
      expect(decideAuthority(kind, telegram).allow).toBe(false);
    }
  });

  it('the telegram peer still needs the core token and a fresh nonce', () => {
    expect(decideAuthority('answer', { ...telegram, token: 'panel-bearer' })).toMatchObject({
      allow: false,
      code: 'signature-required',
    });
    expect(decideAuthority('answer', { ...telegram, nonce: 'invalid' })).toMatchObject({
      allow: false,
      code: 'nonce-invalid',
    });
    expect(decideAuthority('cancel', { ...telegram, nonce: 'absent' })).toMatchObject({
      allow: false,
      code: 'proof-required',
    });
    expect(decideAuthority('answer', { ...telegram, token: 'session' })).toMatchObject({
      allow: false,
      code: 'forged-authority',
    });
  });

  it('a valid device signature proves the human whatever the peer — grant passes only that way', () => {
    expect(decideAuthority('grant', { ...telegram, signature: 'valid' })).toEqual({
      allow: true,
      by: 'device-signature',
    });
  });
});
