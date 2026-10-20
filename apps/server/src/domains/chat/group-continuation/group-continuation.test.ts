import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  continueHerePrompt,
  DEFAULT_COMPACT_WINDOW,
  effectiveCompactWindow,
  GROUP_FRESH_SESSION_SHARE,
  groupContinuation,
  runCompactWindow,
  settingsCompactWindow,
  WARM_DELIVER_MAX_CONTEXT,
  WARM_SESSION_MAX_AGE_MS,
  warmDeliverSession,
} from './group-continuation.ts';

describe('чем продолжать группу (E1)', () => {
  const window = 200_000;
  const edge = window * GROUP_FRESH_SESSION_SHARE;

  it('ниже доли окна сжатия — та же сессия, с доли — чистая', () => {
    expect(
      groupContinuation({ contextTokens: 30_000, compactWindow: window, sessionId: 's' }),
    ).toBe('resume');
    expect(
      groupContinuation({ contextTokens: edge - 1, compactWindow: window, sessionId: 's' }),
    ).toBe('resume');
    expect(groupContinuation({ contextTokens: edge, compactWindow: window, sessionId: 's' })).toBe(
      'fresh',
    );
  });

  it('без сессии продолжать «ту же» нечего — чистая', () => {
    expect(groupContinuation({ contextTokens: 1_000, compactWindow: window })).toBe('fresh');
  });

  it('расход не пришёл (0) — та же сессия: CLI сожмёт её сам', () => {
    expect(groupContinuation({ contextTokens: 0, compactWindow: window, sessionId: 's' })).toBe(
      'resume',
    );
  });

  it('меньшее окно (локальная модель) сдвигает порог вместе с собой', () => {
    expect(
      groupContinuation({ contextTokens: 30_000, compactWindow: 40_000, sessionId: 's' }),
    ).toBe('fresh');
  });
});

describe('окно сжатия прогона', () => {
  it('переменная прогона сильнее настройки, настройка сильнее окна по умолчанию', () => {
    expect(effectiveCompactWindow({ CLAUDE_CODE_AUTO_COMPACT_WINDOW: '64000' }, 250_000)).toBe(
      64_000,
    );
    expect(effectiveCompactWindow({}, 250_000)).toBe(250_000);
    expect(effectiveCompactWindow(undefined, undefined)).toBe(DEFAULT_COMPACT_WINDOW);
  });

  it('мусор и крошечные окна не считаются окном', () => {
    expect(effectiveCompactWindow({ CLAUDE_CODE_AUTO_COMPACT_WINDOW: 'много' }, 100)).toBe(
      DEFAULT_COMPACT_WINDOW,
    );
  });

  // Окно локальной модели и профиля группы реестр кладёт в `platformEnv`, не в
  // `env`: читать только `env` значило принять 65 тыс. за окно каталога (250).
  it('окно прогона берётся и из platformEnv — последним, как при запуске процесса', () => {
    expect(
      runCompactWindow(
        { platformEnv: { CLAUDE_CODE_AUTO_COMPACT_WINDOW: '65536' } },
        undefined,
        250_000,
      ),
    ).toBe(65_536);
    expect(
      runCompactWindow(
        {
          env: { CLAUDE_CODE_AUTO_COMPACT_WINDOW: '120000' },
          platformEnv: { CLAUDE_CODE_AUTO_COMPACT_WINDOW: '65536' },
        },
        160_000,
        250_000,
      ),
    ).toBe(65_536);
    expect(runCompactWindow({}, 160_000, 250_000)).toBe(160_000);
    expect(runCompactWindow({}, undefined, 250_000)).toBe(250_000);
  });

  describe('settings.json каталога конфигурации', () => {
    let dir = '';
    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), 'group-window-'));
    });
    afterEach(() => rmSync(dir, { recursive: true, force: true }));

    it('читает autoCompactWindow; нет файла или он битый — пусто', () => {
      expect(settingsCompactWindow(dir)).toBeUndefined();
      writeFileSync(join(dir, 'settings.json'), '{ битый');
      expect(settingsCompactWindow(dir)).toBeUndefined();
      writeFileSync(join(dir, 'settings.json'), JSON.stringify({ autoCompactWindow: 250_000 }));
      expect(settingsCompactWindow(dir)).toBe(250_000);
    });
  });
});

describe('задание хода той же сессией', () => {
  it('называет следующий шаг и просит не перечитывать то, что уже в окне', () => {
    const prompt = continueHerePrompt({
      done: 'правки сделаны',
      next: 'коммит, пуш, MR',
      checkpoint: '.agent/PROGRESS.md',
    });
    expect(prompt.startsWith('Continue in this same session')).toBe(true);
    expect(prompt).toContain('Next: коммит, пуш, MR');
    expect(prompt).toContain('Do not re-read files');
  });
});

describe('доставка тёплой сессией (E2)', () => {
  const now = 10_000_000;
  const warm = {
    sessionId: 'sess-правки',
    options: { prompt: 'правки', cwd: '/w', model: 'sonnet', effort: 'medium' },
    model: 'sonnet',
    effort: 'medium',
    at: now - 5 * 60_000,
    contextTokens: 60_000,
  };
  const ask = (overrides: Partial<Parameters<typeof warmDeliverSession>[0]> = {}) =>
    warmDeliverSession({
      warm,
      now,
      model: 'sonnet',
      effort: 'medium',
      compactWindow: 200_000,
      ...overrides,
    });

  it('та же модель и глубина, свежая, окно далеко от сжатия — продолжать', () => {
    expect(ask()).toBe(warm);
  });

  it('кэш истёк (55 мин с конца хода) — с чистого листа', () => {
    expect(ask({ now: warm.at + WARM_SESSION_MAX_AGE_MS })).toBeUndefined();
    expect(ask({ now: warm.at + WARM_SESSION_MAX_AGE_MS - 1 })).toBe(warm);
  });

  it('окно не меньше доли окна сжатия или 200k — с чистого листа; расход неизвестен — тоже', () => {
    expect(ask({ warm: { ...warm, contextTokens: 120_000 } })).toBeUndefined();
    expect(ask({ warm: { ...warm, contextTokens: 119_999 } })?.sessionId).toBe('sess-правки');
    expect(
      ask({ warm: { ...warm, contextTokens: 199_000 }, compactWindow: 1_000_000 })?.sessionId,
    ).toBe('sess-правки');
    expect(
      ask({ warm: { ...warm, contextTokens: WARM_DELIVER_MAX_CONTEXT }, compactWindow: 1_000_000 }),
    ).toBeUndefined();
    expect(ask({ warm: { ...warm, contextTokens: 0 } })).toBeUndefined();
  });

  it('другая модель или глубина — другой кэш: с чистого листа', () => {
    expect(ask({ model: 'opus' })).toBeUndefined();
    expect(ask({ effort: 'high' })).toBeUndefined();
  });

  it('через контур ход шёл моделью маршрута без глубины — сравнивается то, что просили', () => {
    const routed = { ...warm, options: { ...warm.options, model: 'contour-model', effort: '' } };
    expect(ask({ warm: routed })).toBe(routed);
    expect(ask({ warm: routed, model: 'contour-model', effort: '' })).toBeUndefined();
  });

  it('тёплой сессии нет — с чистого листа', () => {
    expect(ask({ warm: undefined })).toBeUndefined();
  });
});
