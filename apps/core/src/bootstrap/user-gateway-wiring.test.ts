import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { panelGatewayPort, userGatewayPlanOf, userGatewayPortOf } from './user-gateway-wiring.ts';

/**
 * Где ядро держит шлюз человека (этап 10, C3d: шлюза у панели больше нет). Окружение решает
 * первым; не задано — ядро на доме человека слушает порт из настроек панели (5179 по умолчанию,
 * тот, что вписан в конфиги CLI), а ядро на отдельном доме (стенды QA, тесты) шлюза не открывает:
 * иначе оно заняло бы адрес человека.
 */
describe('порт шлюза человека по окружению', () => {
  it('пусто или пробелы — не задано', () => {
    expect(userGatewayPortOf({})).toBeUndefined();
    expect(userGatewayPortOf({ AGENTDECK_USER_GATEWAY_PORT: '  ' })).toBeUndefined();
  });

  it('порт задан — он; 0, не число или вне 1–65535 — шлюз выключен', () => {
    expect(userGatewayPortOf({ AGENTDECK_USER_GATEWAY_PORT: '5179' })).toBe(5179);
    expect(userGatewayPortOf({ AGENTDECK_USER_GATEWAY_PORT: '0' })).toBeNull();
    expect(userGatewayPortOf({ AGENTDECK_USER_GATEWAY_PORT: 'abc' })).toBeNull();
    expect(userGatewayPortOf({ AGENTDECK_USER_GATEWAY_PORT: '70000' })).toBeNull();
  });
});

describe('план шлюза человека', () => {
  const HOME = process.platform === 'win32' ? 'C:\\Users\\human' : '/home/human';
  const env = (extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => ({
    HOME,
    USERPROFILE: HOME,
    ...extra,
  });

  it('окружение сильнее всего: порт — он, 0 — шлюза нет даже на доме человека', () => {
    expect(userGatewayPlanOf(env({ AGENTDECK_USER_GATEWAY_PORT: '6100' }))).toEqual({
      kind: 'fixed',
      port: 6100,
    });
    expect(userGatewayPlanOf(env({ AGENTDECK_USER_GATEWAY_PORT: '0' }))).toBeNull();
    // Отдельный дом ядра (стенд QA) порт не отменяет: так стенд и открывает шлюз своему ядру.
    expect(
      userGatewayPlanOf(
        env({ AGENTDECK_CORE_HOME: join(HOME, 'qa'), AGENTDECK_USER_GATEWAY_PORT: '6100' }),
        join(HOME, 'qa'),
      ),
    ).toEqual({ kind: 'fixed', port: 6100 });
  });

  it('не задано: дом человека — порт из настроек панели; свой дом ядра — шлюза нет', () => {
    expect(userGatewayPlanOf(env())).toEqual({ kind: 'panel' });
    expect(userGatewayPlanOf(env(), join(HOME, '.agentdeck', 'core'))).toEqual({ kind: 'panel' });
    expect(userGatewayPlanOf(env(), join(HOME, 'qa-stand', 'core'))).toBeNull();
    expect(userGatewayPlanOf(env({ AGENTDECK_CORE_HOME: join(HOME, 'qa') }))).toBeNull();
  });

  it('порт из настроек панели: записан — он, панели нет — 5179', () => {
    expect(panelGatewayPort({ gateway: { port: 5300 } })).toBe(5300);
    expect(panelGatewayPort(undefined)).toBe(5179);
  });
});
