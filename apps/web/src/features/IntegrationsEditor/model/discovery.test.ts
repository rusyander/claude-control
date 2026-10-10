import { describe, expect, it } from 'vitest';
import type { DiscoveredIntegration } from '@agentdeck/contracts';
import { DEFAULT_INTEGRATIONS } from '@entities/Integration';
import { defaultSelection, doubledIntegration, isTransferable } from './discoverySelection';
import { isIntegrationSet } from './isIntegrationSet';

const found = (patch: Partial<DiscoveredIntegration>): DiscoveredIntegration => ({
  key: 'user:gl:gitlab',
  id: 'gitlab',
  server: 'gl',
  source: 'user',
  launch: 'npx',
  package: '@zereight/mcp-gitlab',
  fields: {},
  hasToken: true,
  maskedToken: 'glp…4f21',
  missing: [],
  alreadyConnected: false,
  replaces: false,
  ...patch,
});

describe('isIntegrationSet', () => {
  it('пустая выключенная без ключа — не заведена', () => {
    expect(isIntegrationSet('jira', DEFAULT_INTEGRATIONS, undefined)).toBe(false);
  });

  it('включена, есть ключ или хоть одно поле — заведена', () => {
    const withUrl = {
      ...DEFAULT_INTEGRATIONS,
      jira: { ...DEFAULT_INTEGRATIONS.jira, baseUrl: 'https://jira.acme' },
    };
    expect(isIntegrationSet('jira', withUrl, undefined)).toBe(true);
    expect(isIntegrationSet('confluence', withUrl, undefined)).toBe(false);

    const enabled = {
      ...DEFAULT_INTEGRATIONS,
      telegram: { ...DEFAULT_INTEGRATIONS.telegram, enabled: true },
    };
    expect(isIntegrationSet('telegram', enabled, undefined)).toBe(true);

    const status = { id: 'github', hasToken: true } as Parameters<typeof isIntegrationSet>[2];
    expect(isIntegrationSet('github', DEFAULT_INTEGRATIONS, status)).toBe(true);
  });
});

describe('выбор находок', () => {
  it('неполная и уже подключённая не переносятся', () => {
    expect(isTransferable(found({ missing: ['token'] }))).toBe(false);
    expect(isTransferable(found({ alreadyConnected: true }))).toBe(false);
    expect(isTransferable(found({ replaces: true }))).toBe(true);
  });

  it('по умолчанию отмечено по одной находке на интеграцию, первая — общая', () => {
    const items = [
      found({ key: 'a' }),
      found({ key: 'b', source: 'project', project: '/repo' }),
      found({ key: 'c', id: 'telegram', missing: ['chatId'] }),
      found({ key: 'd', id: 'jira' }),
    ];
    expect(defaultSelection(items)).toEqual(['a', 'd']);
  });

  it('два сервера на одну интеграцию называются до запроса', () => {
    const items = [found({ key: 'a' }), found({ key: 'b' }), found({ key: 'd', id: 'jira' })];
    expect(doubledIntegration(items, ['a', 'd'])).toBeUndefined();
    expect(doubledIntegration(items, ['a', 'b', 'd'])).toBe('gitlab');
  });
});
