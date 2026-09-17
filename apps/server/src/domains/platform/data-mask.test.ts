import { afterAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultOurRules, defaultPlatformRules } from '@agentdeck/contracts/platform';
import { defaultPlatformTransport } from '@agentdeck/contracts/platform-transport';
import type { Platform } from '@agentdeck/contracts';
import { saveRules } from '../dlp/rules-store.ts';
import { dataMaskOn, describeDataMask } from './data-mask.ts';
import { driverFor } from './drivers/index.ts';

/**
 * Одно решение на шлюз и карточку (Р11). Шлюз проверен своим интеграционным
 * тестом; здесь — что карточка называет ту же причину, по которой шлюз маскирует.
 */

const PLATFORM: Platform = {
  id: 'g',
  title: 'Контур',
  driver: 'enterprise-platform',
  baseUrl: 'https://api.example.ru',
  enabled: true,
  mode: 'required',
  budgetUsd: 0,
  capabilities: [],
  targets: [],
  projectPaths: [],
  consumers: [],
  agents: [],
  budgetSince: '',
  toolShim: true,
  contourPrompt: true,
  defaultModel: '',
  consumerModels: {},
  modelMap: {},
  rules: { platform: defaultPlatformRules(), ours: defaultOurRules() },
  caCertPath: '',
  transport: defaultPlatformTransport(),
};

const enterprise = driverFor('enterprise-platform');
const compat = driverFor('openai-compat');
const made: string[] = [];
const dir = (): string => {
  const d = mkdtempSync(join(tmpdir(), 'data-mask-'));
  made.push(d);
  return d;
};
afterAll(() => {
  for (const d of made) rmSync(d, { recursive: true, force: true });
});

describe('маска данных контура', () => {
  it('контур с подменой: включена сама, причина «объявлено», набор встроенный', () => {
    const mask = describeDataMask(PLATFORM, enterprise, false, dir());
    expect(mask).toMatchObject({ on: true, reason: 'declared', declared: true, rules: 'builtin' });
    expect(mask.count).toBeGreaterThan(15);
    expect(dataMaskOn(PLATFORM, enterprise, false)).toBe(true);
  });

  it('снятая человеком: выключена, причина «выбор», пока не включён общий выключатель', () => {
    const off = { ...PLATFORM, dataMask: false };
    expect(describeDataMask(off, enterprise, false, dir())).toMatchObject({
      on: false,
      reason: 'chosen',
    });
    expect(describeDataMask(off, enterprise, true, dir())).toMatchObject({
      on: true,
      reason: 'global',
    });
    expect(dataMaskOn(off, enterprise, true)).toBe(true);
  });

  it('совместимый шлюз: маски нет, пока её не включили на карточке или общим', () => {
    const plain = { ...PLATFORM, driver: 'openai-compat' as const };
    expect(describeDataMask(plain, compat, false, dir())).toMatchObject({
      on: false,
      reason: 'none',
      declared: false,
    });
    expect(describeDataMask({ ...plain, dataMask: true }, compat, false, dir())).toMatchObject({
      on: true,
      reason: 'chosen',
    });
  });

  it('свои правила раздела названы своими и посчитаны', () => {
    const where = dir();
    saveRules(where, [
      {
        id: 'r1',
        name: 'Сотрудники',
        enabled: true,
        kind: 'terms',
        terms: ['Иванов'],
        pattern: '',
        action: 'mask',
        label: 'ИМЯ',
      },
    ]);
    expect(describeDataMask(PLATFORM, enterprise, false, where)).toMatchObject({
      rules: 'own',
      count: 1,
    });
  });
});
