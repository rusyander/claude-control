import { describe, it, expect } from 'vitest';
import { QueryClient } from '@tanstack/react-query';
import { appSettingsSchema, type AppSettings } from '@claude-control/contracts';
import { queryKeys } from '@shared/api/query-keys';
import { applySettingsUpdate } from './AppConfigApi';

const settings = (patch: Partial<AppSettings>): AppSettings => appSettingsSchema.parse(patch);

/** Кеш, каким он остаётся после открытых разделов прошлого провайдера. */
function seed(): QueryClient {
  const client = new QueryClient();
  client.setQueryData(queryKeys.providerRules, ['cursor rule']);
  client.setQueryData(queryKeys.providerRule('team.mdc'), 'cursor rule body');
  client.setQueryData(queryKeys.providerMcp, ['cursor mcp']);
  client.setQueryData(queryKeys.providerHooks, ['cursor hook']);
  client.setQueryData(queryKeys.providerSkills, ['cursor skill']);
  client.setQueryData(queryKeys.providerEnv, ['cursor env']);
  client.setQueryData(queryKeys.providerPermissions, ['cursor permission']);
  client.setQueryData(queryKeys.providerInstructions, ['cursor instructions']);
  client.setQueryData(queryKeys.providerPlugins, ['cursor plugin']);
  client.setQueryData(queryKeys.models, ['cursor model']);
  client.setQueryData(queryKeys.claudeMd, { content: 'cursor instructions file' });
  client.setQueryData(queryKeys.projectProviderRules('p1'), ['cursor project rule']);
  client.setQueryData(queryKeys.projectProviderMcp('p1'), ['cursor project mcp']);
  // Поиск идёт по разделам активного провайдера — выдача тоже устаревает.
  client.setQueryData(queryKeys.search('mcp'), { results: ['cursor hit'] });
  // Не зависят от активного провайдера — переживают переключение.
  client.setQueryData(queryKeys.rules, ['claude rule']);
  client.setQueryData(queryKeys.overview, { rules: { total: 1 } });
  client.setQueryData(queryKeys.projectRules('p1'), 'claude project md');
  client.setQueryData(queryKeys.formatCheck, { report: 'shared' });
  return client;
}

const PROVIDER_SCOPED = [
  queryKeys.providerRules,
  queryKeys.providerRule('team.mdc'),
  queryKeys.providerMcp,
  queryKeys.providerHooks,
  queryKeys.providerSkills,
  queryKeys.providerEnv,
  queryKeys.providerPermissions,
  queryKeys.providerInstructions,
  queryKeys.providerPlugins,
  queryKeys.models,
  queryKeys.claudeMd,
  queryKeys.projectProviderRules('p1'),
  queryKeys.projectProviderMcp('p1'),
  queryKeys.search('mcp'),
];

describe('applySettingsUpdate', () => {
  it('сбрасывает кеш разделов прошлого провайдера при переключении', () => {
    const client = seed();

    applySettingsUpdate(client, settings({ provider: 'codex' }), { provider: 'codex' });

    // Иначе раздел рисуется файлами Cursor, а «Сохранить» уходит в конфиг Codex.
    for (const key of PROVIDER_SCOPED) {
      expect(client.getQueryData(key), key.join('/')).toBeUndefined();
    }
  });

  it('не трогает разделы, не зависящие от провайдера', () => {
    const client = seed();

    applySettingsUpdate(client, settings({ provider: 'codex' }), { provider: 'codex' });

    expect(client.getQueryData(queryKeys.rules)).toEqual(['claude rule']);
    expect(client.getQueryData(queryKeys.overview)).toEqual({ rules: { total: 1 } });
    expect(client.getQueryData(queryKeys.projectRules('p1'))).toBe('claude project md');
    expect(client.getQueryData(queryKeys.formatCheck)).toEqual({ report: 'shared' });
  });

  it('статус API-ключей переживает переключение провайдера', () => {
    // Имя ключа начинается на `provider-`, но раздел отдаёт ключи ВСЕХ
    // провайдеров сразу: сброс гасил бы форму вместе с введённым ключом.
    const client = seed();
    client.setQueryData(queryKeys.providerKeys, [{ id: 'codex', hasKey: true }]);

    applySettingsUpdate(client, settings({ provider: 'codex' }), { provider: 'codex' });

    expect(client.getQueryData(queryKeys.providerKeys)).toEqual([{ id: 'codex', hasKey: true }]);
  });

  it('правка темы кеш разделов не сбрасывает', () => {
    const client = seed();

    applySettingsUpdate(client, settings({ theme: 'dark' }), { theme: 'dark' });

    expect(client.getQueryData(queryKeys.providerRules)).toEqual(['cursor rule']);
    expect(client.getQueryData(queryKeys.models)).toEqual(['cursor model']);
  });

  it('ответ сервера кладётся в кеш настроек сразу', () => {
    const client = seed();
    const next = settings({ theme: 'dark' });

    applySettingsUpdate(client, next, { theme: 'dark' });

    expect(client.getQueryData(queryKeys.settings)).toBe(next);
  });
});
