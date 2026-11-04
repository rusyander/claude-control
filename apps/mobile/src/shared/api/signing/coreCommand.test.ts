import { describe, expect, it } from 'vitest';
import { coreCommandSignature } from './coreCommand';
import { keyFromSeed } from './signing';

/**
 * Подпись команды ядру телефоном — закреплённый вектор. Ядро судит её своим проверяющим
 * (`apps/core/src/policy/authority/device-signature.ts`), и импорт кода ядра из телефона запрещён
 * границей (`panel-apart-from-core`): обе стороны сверяются с одним вектором — здесь телефон
 * подписывает, в ядре (`api/commands.phone-permit.test.ts`) тот же заголовок проверяется и
 * принимается. Расхождение в любом байте текста подписи краснеет с одной из сторон.
 */

const SEED = Uint8Array.from({ length: 32 }, (_, index) => index);

const CORE_VECTOR = {
  panel: 'panel-golden-0001',
  command: {
    cmdId: '019a4b2c-0000-7000-8000-000000000001',
    kind: 'answer' as const,
    target: { taskId: '019a4b2c-0000-7000-8000-0000000000aa' },
    fields: { askId: '019a4b2c-0000-7000-8000-0000000000bb', answer: 'grant' },
  },
  nonce: 'golden-nonce-0001',
  time: 1_793_000_000_000,
  header:
    'v1;device=56475aa75463474c;nonce=golden-nonce-0001;time=1793000000000;' +
    'sig=s09NrIDJ8tNVxBfOEdjqHq2B01dnLLGxiX33wWBELhwV50bAfHxSWX4Dyf00wt75p23pHGwdSExW5UNK_ZsiBw',
};

describe('core command signature — golden vector shared with the core', () => {
  it('the pinned seed signs the pinned answer byte for byte', () => {
    const header = coreCommandSignature({
      key: keyFromSeed(SEED),
      panel: CORE_VECTOR.panel,
      command: CORE_VECTOR.command,
      nonce: CORE_VECTOR.nonce,
      time: CORE_VECTOR.time,
    });
    expect(header).toBe(CORE_VECTOR.header);
  });
});
