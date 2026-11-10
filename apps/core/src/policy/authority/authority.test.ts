import { describe, expect, it } from 'vitest';
import { COMMAND_KINDS, type AuthorityKind } from '@agentdeck/contracts/core/commands';
import { COMMAND_PROOF_CLASS, decideAuthority, type CommandProof } from './authority.ts';
import { createNonceStore, NONCE_LIMIT, NONCE_TTL_MS } from './nonce.ts';

/**
 * Таблица 06 §Authority, переписанная из спецификации отдельно от кода: строки — виды команд,
 * столбцы — доказательства. Код и эта таблица обязаны совпасть на всём произведении. Оценка
 * (`/v1/estimate`) — строка таблицы наравне с командами: её судит тот же суд (G5).
 */
const KINDS: readonly AuthorityKind[] = [
  ...COMMAND_KINDS,
  'estimate',
  'set-config',
  'save-scenario',
  'adopt-devices',
  'learned-reset',
  // Этап 12 (08e): ход на доске — суд тот же, задачи у записи ещё нет.
  'board-move',
];
const STRICT_FROM_SPEC: ReadonlySet<AuthorityKind> = new Set([
  'set-config',
  // Этап 9 (F6, F11): библиотека сценариев и ключи устройств — строго, как настройка ядра.
  'save-scenario',
  'adopt-devices',
  // Этап 11 (P140): таблица обучения общая для всех задач машины — сброс ключа строго.
  'learned-reset',
  'answer',
  'edit-requirements',
  'approve-split',
  'grant',
  'fresh-rerun',
  'publish-now',
  'release-resource',
  'move-build',
  'clean-remote',
  'clear-exhausted',
  // Этап 12 (08e): перехват — правка копии рукой человека, строго, как грант.
  'take-over',
]);

function specVerdict(kind: AuthorityKind, p: CommandProof): string {
  if (p.token === 'session' || p.peer === 'session-descendant') return 'forged-authority';
  if (p.token === 'none') return 'proof-required';
  if (p.signature === 'valid') return 'allow';
  if (p.signature === 'invalid') return 'signature-invalid';
  if (p.peer === 'remote' || p.peer === 'untrusted-forward') return 'signature-required';
  if (p.peer === 'unknown' && STRICT_FROM_SPEC.has(kind)) return 'signature-required';
  if (p.nonce === 'valid') return 'allow';
  if (p.nonce === 'invalid') return 'nonce-invalid';
  return 'proof-required';
}

const TOKENS: CommandProof['token'][] = ['none', 'panel-bearer', 'core', 'session'];
const NONCES: CommandProof['nonce'][] = ['absent', 'valid', 'invalid'];
const PEERS: CommandProof['peer'][] = [
  'clear',
  'session-descendant',
  'unknown',
  'remote',
  'untrusted-forward',
];
const SIGNATURES: CommandProof['signature'][] = ['absent', 'valid', 'invalid'];

describe('authority', () => {
  it('P97 every command kind × proof (token, nonce, peer, signature) matches the 06 table', () => {
    let rows = 0;
    const mismatches: string[] = [];
    for (const kind of KINDS) {
      for (const token of TOKENS)
        for (const nonce of NONCES)
          for (const peer of PEERS)
            for (const signature of SIGNATURES) {
              const proof = { token, nonce, peer, signature };
              const got = decideAuthority(kind, proof);
              const verdict = got.allow ? 'allow' : got.code;
              rows += 1;
              if (verdict !== specVerdict(kind, proof))
                mismatches.push(`${kind} ${JSON.stringify(proof)} → ${verdict}`);
              if (!got.allow && got.code === 'forged-authority')
                expect(got.signal).toBe('forged-authority');
            }
    }
    expect(mismatches).toEqual([]);
    expect(rows).toBe(KINDS.length * 4 * 3 * 5 * 3);
    for (const kind of KINDS) {
      expect({ kind, strict: COMMAND_PROOF_CLASS[kind] === 'human-strict' }).toEqual({
        kind,
        strict: STRICT_FROM_SPEC.has(kind),
      });
    }
  });

  it('P41 named corpus rows: no token proves a human; a session-descendant peer is refused even with a signature', () => {
    const base: CommandProof = {
      token: 'core',
      nonce: 'absent',
      peer: 'clear',
      signature: 'absent',
    };
    expect(decideAuthority('launch', base)).toMatchObject({ allow: false, code: 'proof-required' });
    expect(decideAuthority('launch', { ...base, token: 'panel-bearer' })).toMatchObject({
      allow: false,
    });
    expect(
      decideAuthority('answer', { ...base, peer: 'session-descendant', signature: 'valid' }),
    ).toMatchObject({
      allow: false,
      signal: 'forged-authority',
    });
    expect(decideAuthority('launch', { ...base, peer: 'remote', nonce: 'valid' })).toMatchObject({
      code: 'signature-required',
    });
    expect(decideAuthority('launch', { ...base, peer: 'remote', signature: 'valid' })).toEqual({
      allow: true,
      by: 'device-signature',
    });
  });

  it('P41 nonce: minted per page load, one use, foreign page and expiry refused, bounded store', () => {
    let now = 1_000;
    const store = createNonceStore(() => now);
    const a = store.mint('page-a');
    expect(store.consume(a.nonce, 'page-a')).toBe('valid');
    expect(store.consume(a.nonce, 'page-a')).toBe('invalid');
    const b = store.mint('page-a');
    expect(store.consume(b.nonce, 'page-b')).toBe('invalid');
    // Показанное чужой странице число сгорело и для своей.
    expect(store.consume(b.nonce, 'page-a')).toBe('invalid');
    const c = store.mint('page-a');
    now += NONCE_TTL_MS;
    expect(store.consume(c.nonce, 'page-a')).toBe('invalid');
    expect(store.consume(undefined, 'page-a')).toBe('absent');
    expect(store.consume('never-minted', 'page-a')).toBe('invalid');
    for (let i = 0; i < NONCE_LIMIT + 50; i += 1) store.mint(`p${i}`);
    store.mint('last');
    expect(store.size).toBeLessThanOrEqual(NONCE_LIMIT + 1);
  });

  it('F-109 a flood of foreign mints does not push out a live page nonce', () => {
    const store = createNonceStore(() => 1_000);
    const mine = store.mint('page-mine');
    for (let i = 0; i < NONCE_LIMIT + 1; i += 1) store.mint(`foreign-${i}`);
    // Последнее выданное число тоже живо: выдача не отдаёт мёртвых чисел.
    const last = store.mint('page-late');
    expect(store.size).toBeLessThanOrEqual(NONCE_LIMIT);
    expect(store.consume(mine.nonce, 'page-mine')).toBe('valid');
    expect(store.consume(last.nonce, 'page-late')).toBe('valid');
  });

  it('F-109 one page holds a bounded number of live nonces, its oldest go first', () => {
    const store = createNonceStore(() => 1_000);
    const first = store.mint('page-a');
    for (let i = 0; i < 50; i += 1) store.mint('page-a');
    expect(store.size).toBeLessThanOrEqual(8);
    expect(store.consume(first.nonce, 'page-a')).toBe('invalid');
  });
});
