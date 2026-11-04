import { describe, expect, it } from 'vitest';
import { adoptDevicesBodySchema } from '@agentdeck/contracts/core/panel-api';
import { adoptDevicesBody } from './adopt';

/**
 * Перенос ключей телефона в ядро из окна панели: тело несёт номер машины панели (им подписывает
 * телефон), все ключи с отметкой отзыва и число страницы — и проходит строгую схему ядра.
 */

const CMD = '019a0000-0000-7000-8000-0000000000c1';
const PAGE = '019a0000-0000-7000-8000-0000000000d1';
const KEY = 'A'.repeat(43);

describe('adopt devices body', () => {
  it('panel machine id, active and revoked keys, page proof; valid for the core schema', () => {
    const body = adoptDevicesBody(
      {
        machineId: '43ce662e-6b8f-48d8-8db7-d3576f318655',
        devices: [
          { id: '0123456789abcdef', publicKey: KEY },
          { id: 'fedcba9876543210', publicKey: KEY, revokedAt: '2026-11-01T00:00:00Z' },
        ],
      },
      'nonce-1',
      PAGE,
      CMD,
    );
    expect(body).toEqual({
      cmdId: CMD,
      machineId: '43ce662e-6b8f-48d8-8db7-d3576f318655',
      devices: [
        { id: '0123456789abcdef', publicKey: KEY },
        { id: 'fedcba9876543210', publicKey: KEY, revokedAt: '2026-11-01T00:00:00Z' },
      ],
      proof: { nonce: 'nonce-1', page: PAGE },
    });
    expect(adoptDevicesBodySchema.safeParse(body).success).toBe(true);
    // Без номера машины ядро тело не примет — его и закрывает перенос.
    const { machineId: _dropped, ...withoutMachine } = body;
    expect(adoptDevicesBodySchema.safeParse(withoutMachine).success).toBe(false);
  });
});
