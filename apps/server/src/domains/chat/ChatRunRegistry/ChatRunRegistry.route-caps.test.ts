import { describe, it, expect, beforeEach } from 'vitest';
import { ChatRunRegistry, type RunLike } from './ChatRunRegistry.ts';
import type { RunOptions } from '../ChatRunner/ChatRunner.ts';
import type { GroupRunProfile } from '../group-profile/group-profile.ts';
import { capKitToRoute } from './route-caps.ts';

/**
 * n2/n1 (economy-providers, пакет K): профиль группы кладётся поверх окружения
 * маршрута, а потолок чтения — в `--settings`, который сильнее окружения. На
 * локальной модели с окном 32 тыс. группа получала окно 200 тыс. и потолок
 * чтения 10 тыс.: сжатие не наступало, чтение переполняло окно. Здесь через
 * настоящий `start()` реестра видно, что уезжает в CLI: меньшее из двух.
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

const profile: GroupRunProfile = {
  args: [],
  env: { ENABLE_CLAUDEAI_MCP_SERVERS: 'false', [WINDOW]: '200000' },
  note: '',
  settings: { env: { BASH_MAX_TIMEOUT_MS: '600000', [READ]: '10000' }, skillOverrides: {} },
};

describe('ChatRunRegistry: пределы маршрута сильнее профиля группы', () => {
  let registry: ChatRunRegistry;
  beforeEach(() => {
    registry = new ChatRunRegistry(() => new IdleRun());
    registry.setGroupProfileResolver(() => profile);
  });

  it('локальная модель: окно и потолок чтения группы опущены до своих', () => {
    registry.setPlatformRouting(() => ({ env: { [WINDOW]: '32768', [READ]: '4000' } }));
    registry.start('g1', OPTIONS, { sessionId: 's1' });
    const options = registry.describe('g1')?.options;
    expect(options?.platformEnv?.[WINDOW]).toBe('32768');
    expect(options?.platformSettings).toEqual({
      env: { BASH_MAX_TIMEOUT_MS: '600000', [READ]: '4000' },
      skillOverrides: {},
    });
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
 * тем же путём, что профиль группы до n2. Действует меньшее из трёх источников.
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

  it('предел набора ниже маршрута: он же прижимает и группу — меньшее из трёх', () => {
    registry.setGroupProfileResolver(() => ({
      ...profile,
      settings: { env: { [READ]: '20000' }, skillOverrides: {} },
    }));
    registry.setPlatformRouting(() => ({
      env: { [READ]: '25000' },
      kit: { args: [], env: KIT_ENV },
    }));
    registry.start('g1', OPTIONS, { sessionId: 's1' });
    const options = registry.describe('g1')?.options;
    expect(options?.platformEnv?.[READ]).toBe('10000');
    expect(options?.platformSettings).toEqual({ env: { [READ]: '10000' }, skillOverrides: {} });
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
    const own: GroupRunProfile = {
      ...profile,
      settings: { env: { [READ]: '20000' }, skillOverrides: {} },
    };
    registry.setGroupProfileResolver(() => own);
    const route = { env: {}, kit: { args: [], env: KIT_ENV } };
    registry.setPlatformRouting(() => route);
    registry.start('g1', OPTIONS, { sessionId: 's1' });
    const options = registry.describe('g1')?.options;
    expect(options?.platformEnv).toEqual({ ...KIT_ENV, ...own.env });
    // Свой потолок группы выше набора — и сильнее его (`--settings`), как до правки.
    expect(options?.platformSettings).toBe(own.settings);
    expect(capKitToRoute(route)).toBe(KIT_ENV);
  });
});
