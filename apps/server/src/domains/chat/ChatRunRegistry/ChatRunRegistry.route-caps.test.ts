import { describe, it, expect, beforeEach } from 'vitest';
import { ChatRunRegistry, type RunLike } from './ChatRunRegistry.ts';
import type { RunOptions } from '../run-options/run-options.ts';
import type { GroupRunProfile } from '../group-profile/group-profile.ts';
import { capKitToRoute } from './route-caps.ts';

/**
 * n2/n1 (economy-providers, пакет K): профиль кладётся поверх окружения маршрута.
 * На локальной модели с окном 32 тыс. профиль с окном 200 тыс. не давал сжатию
 * наступить. Здесь через настоящий `start()` реестра видно, что уезжает в
 * прогон: меньшее из двух. Настройки профиля (s12) — только хуки, их предел
 * маршрута не трогает.
 */

class IdleRun implements RunLike {
  start(): Promise<void> {
    return new Promise<void>(() => undefined);
  }
  stop(): void {}
}

const OPTIONS: RunOptions = { prompt: 'привет', cwd: '/tmp/x', model: 'claude-haiku-5-5' };
const WINDOW = 'CLAUDE_CODE_AUTO_COMPACT_WINDOW';
const READ = 'CLAUDE_CODE_FILE_READ_MAX_OUTPUT_TOKENS';
const HOOKS = {
  PreToolUse: [{ matcher: 'mcp__.*__jira_search', hooks: [{ type: 'command', command: 'b' }] }],
};

const profile: GroupRunProfile = {
  args: [],
  env: { ENABLE_CLAUDEAI_MCP_SERVERS: 'false', [WINDOW]: '200000' },
  note: '',
  settings: { hooks: HOOKS },
};

describe('ChatRunRegistry: пределы маршрута сильнее профиля группы', () => {
  let registry: ChatRunRegistry;
  beforeEach(() => {
    registry = new ChatRunRegistry(() => new IdleRun());
    registry.setGroupProfileResolver(() => profile);
  });

  it('локальная модель: окно профиля опущено до своего, хуки профиля как были', () => {
    registry.setPlatformRouting(() => ({ env: { [WINDOW]: '32768', [READ]: '4000' } }));
    registry.start('g1', OPTIONS, { sessionId: 's1' });
    const options = registry.describe('g1')?.options;
    expect(options?.platformEnv?.[WINDOW]).toBe('32768');
    expect(options?.platformEnv?.[READ]).toBe('4000');
    expect(options?.platformSettings).toBe(profile.settings);
  });

  it('контур: окно группы не выше окна модели по каталогу', () => {
    registry.setPlatformRouting(() => ({ env: {}, modelContext: 128_000 }));
    registry.start('g1', OPTIONS, { sessionId: 's1' });
    const options = registry.describe('g1')?.options;
    expect(options?.platformEnv?.[WINDOW]).toBe('128000');
    expect(options?.platformSettings).toEqual(profile.settings);
  });

  it('предел маршрута шире группы — рычаг группы остаётся как был', () => {
    registry.setPlatformRouting(() => ({
      env: { [WINDOW]: '262144', [READ]: '25000' },
      modelContext: 1_000_000,
    }));
    registry.start('g1', OPTIONS, { sessionId: 's1' });
    const options = registry.describe('g1')?.options;
    expect(options?.platformEnv?.[WINDOW]).toBe('200000');
    expect(options?.platformSettings).toEqual(profile.settings);
  });

  it('мимо контура профиль уезжает байт в байт', () => {
    registry.start('g1', OPTIONS, { sessionId: 's1' });
    const options = registry.describe('g1')?.options;
    expect(options?.platformEnv).toEqual(profile.env);
    expect(options?.platformSettings).toBe(profile.settings);
  });

  it('«0» и пустое у маршрута — не предел: группа уезжает как была', () => {
    registry.setPlatformRouting(() => ({ env: { [WINDOW]: '', [READ]: '0' } }));
    registry.start('g1', OPTIONS, { sessionId: 's1' });
    const options = registry.describe('g1')?.options;
    expect(options?.platformEnv?.[WINDOW]).toBe('200000');
    expect(options?.platformSettings).toBe(profile.settings);
  });
});

/**
 * Ревью K, 🟡1: набор панели в режиме «Наши» (`OURS_CLAUDE_CAPS`) кладёт потолок
 * чтения 10 тыс. окружением ПОСЛЕ маршрута — и на локальной модели затирал её 4 тыс.
 * Действует меньшее из источников.
 */
const KIT_ENV = {
  KIT_VARIANT: 'local',
  BASH_MAX_OUTPUT_LENGTH: '8000',
  [READ]: '10000',
};

describe('ChatRunRegistry: потолки набора панели под пределами маршрута', () => {
  let registry: ChatRunRegistry;
  beforeEach(() => {
    registry = new ChatRunRegistry(() => new IdleRun());
  });

  it('локальная модель без группы: потолок чтения набора опущен до своего', () => {
    registry.setPlatformRouting(() => ({
      env: { [WINDOW]: '32768', [READ]: '4000' },
      kit: { args: [], env: KIT_ENV },
    }));
    registry.start('g1', OPTIONS, { sessionId: 's1' });
    const env = registry.describe('g1')?.options.platformEnv;
    expect(env?.[READ]).toBe('4000');
    expect(env?.[WINDOW]).toBe('32768');
    // Остальное от набора — как было.
    expect(env?.BASH_MAX_OUTPUT_LENGTH).toBe('8000');
    expect(env?.KIT_VARIANT).toBe('local');
  });

  it('предел набора ниже маршрута: в окружении остаётся предел набора, хуки группы как были', () => {
    registry.setGroupProfileResolver(() => profile);
    registry.setPlatformRouting(() => ({
      env: { [READ]: '25000' },
      kit: { args: [], env: KIT_ENV },
    }));
    registry.start('g1', OPTIONS, { sessionId: 's1' });
    const options = registry.describe('g1')?.options;
    expect(options?.platformEnv?.[READ]).toBe('10000');
    expect(options?.platformSettings).toBe(profile.settings);
  });

  it('«0» у набора под пределом маршрута не снимает предел', () => {
    registry.setPlatformRouting(() => ({
      env: { [READ]: '4000' },
      kit: { args: [], env: { [READ]: '0', [WINDOW]: '' } },
    }));
    registry.start('g1', OPTIONS, { sessionId: 's1' });
    const env = registry.describe('g1')?.options.platformEnv;
    expect(env?.[READ]).toBe('4000');
    // Окна у маршрута нет — пустое у набора остаётся его делом, как было.
    expect(env?.[WINDOW]).toBe('');
  });

  it('мимо контура (облачный Claude): набор и группа уезжают байт в байт', () => {
    registry.setGroupProfileResolver(() => profile);
    const route = { env: {}, kit: { args: [], env: KIT_ENV } };
    registry.setPlatformRouting(() => route);
    registry.start('g1', OPTIONS, { sessionId: 's1' });
    const options = registry.describe('g1')?.options;
    expect(options?.platformEnv).toEqual({ ...KIT_ENV, ...profile.env });
    expect(options?.platformSettings).toBe(profile.settings);
    expect(capKitToRoute(route)).toBe(KIT_ENV);
  });
});
