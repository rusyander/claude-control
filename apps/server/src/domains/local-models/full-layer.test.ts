import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { Platform } from '@agentdeck/contracts';
import { defaultOurRules, platformSchema } from '@agentdeck/contracts/platform';
import { AppStore } from '../../lib/app-store/app-store.ts';
import { readPlatforms, writePlatform } from '../platform/store/store.ts';
import { localLeanRules, localPlatformSettings } from './connect.ts';
import { FULL_LAYER_MARKER, runLocalFullLayer } from './full-layer.ts';

/**
 * Локальный контур, заведённый до 15.10, нёс облегчённый набор, которого человек не
 * выбирал (L6). Старт панели переводит его на полный — один раз и только его:
 * облегчённый набор, выбранный после перевода, следующий старт не трогает.
 * Хранилище настоящее, во временном каталоге — не `~/.claude`.
 */
let root: string;
let appData: string;
let store: AppStore;

function localRecord(ours = localLeanRules()): Platform {
  const settings = localPlatformSettings({
    baseUrl: 'http://127.0.0.1:11435',
    model: 'qwen3.6:27b-coding',
    title: 'Qwen3.6 27B Coding',
    consumers: ['chat'],
    rules: {
      platform: {
        platformTools: [],
        toolMode: 'loop',
        generationPreset: '',
        enableThinking: 'default',
      },
      ours,
    },
  });
  return platformSchema.parse(settings) as Platform;
}

const oursOf = () => readPlatforms(store).find((item) => item.id === 'local-ollama')?.rules.ours;
const quiet = () => undefined;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'cc-full-layer-'));
  appData = join(root, 'agentdeck');
  store = new AppStore(appData);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('runLocalFullLayer', () => {
  it('новый контур заводится с полным набором', () => {
    expect(
      localPlatformSettings({ baseUrl: 'x', model: 'm', title: 't', consumers: [] }),
    ).toMatchObject({
      rules: { ours: defaultOurRules() },
    });
  });

  it('облегчённый набор панели → полный; повторный старт уже ничего не делает', () => {
    writePlatform(store, localRecord());
    expect(runLocalFullLayer(store, appData, quiet)).toBe('migrated');
    expect(oursOf()).toEqual(defaultOurRules());
    expect(existsSync(join(appData, FULL_LAYER_MARKER))).toBe(true);

    // Человек выбрал облегчённый набор на карточке ПОСЛЕ перевода — старт его не возвращает.
    writePlatform(store, localRecord());
    expect(runLocalFullLayer(store, appData, quiet)).toBe('done');
    expect(oursOf()).toEqual(localLeanRules());
  });

  it('свой выбор человека (не ровно облегчённый набор) не трогается', () => {
    const own = { ...localLeanRules(), skills: false };
    writePlatform(store, localRecord(own));
    expect(runLocalFullLayer(store, appData, quiet)).toBe('kept');
    expect(oursOf()).toEqual(own);
  });

  it('локального контура нет — отметка ставится, чужие контуры не трогаются', () => {
    writePlatform(store, { ...localRecord(), id: 'company' });
    expect(runLocalFullLayer(store, appData, quiet)).toBe('absent');
    expect(readPlatforms(store)[0]?.rules.ours).toEqual(localLeanRules());
    expect(existsSync(join(appData, FULL_LAYER_MARKER))).toBe(true);
  });
});
