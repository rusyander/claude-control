import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { LocalLayerStatus } from '@agentdeck/contracts';
import { i18n } from '@shared/config/i18n';

/**
 * Карточка «Локальный слой» (s10 G14 p7): слой включён, а Claude Code папке не доверяет — ядро его
 * не повезёт и ход откажет (F-86). Карточка говорит это ДО хода, на языке интерфейса, с выходом
 * (доверить папку или выключить слой), а не «подключён». Хуки сущности подменены.
 */

let status: LocalLayerStatus;
vi.mock('@entities/Project', () => ({
  useProjectLocalLayer: () => ({ data: status, isError: false }),
  useSetLocalLayerMode: () => ({ mutate: () => {}, isPending: false }),
}));

const { LocalLayerCard } = await import('./LocalLayerCard');

const base: LocalLayerStatus = {
  root: '/w/app',
  mode: 'on',
  configured: true,
  used: true,
  reason: 'on',
  instructions: { files: 1, teamChars: 10, layerChars: 8, sections: 1, compressed: 0, pending: [] },
  pathRules: 0,
  skills: [],
  agents: 0,
  commands: 0,
  mcpServers: [],
  hooks: 0,
  overrides: [],
  orphans: [],
  excluded: 0,
};

const render = (next: Partial<LocalLayerStatus>): string => {
  status = { ...base, ...next };
  return renderToStaticMarkup(<LocalLayerCard projectId="p1" />);
};

afterEach(async () => {
  await i18n.changeLanguage('ru');
});

describe('LocalLayerCard: folder trust (s10 G14 p7)', () => {
  it.each(['ru', 'en'] as const)(
    '%s: layer on in an untrusted folder → warning badge and the way out, not «in use»',
    async (lang) => {
      await i18n.changeLanguage(lang);
      const html = render({ folderTrust: 'untrusted' });
      expect(html).toContain('data-testid="local-layer-untrusted"');
      expect(html).toContain(i18n.t('localLayer.state.untrusted'));
      expect(html).not.toContain(i18n.t('localLayer.state.used'));
      expect(html).not.toContain('data-testid="local-layer-reason"');
      const text = i18n.t('localLayer.untrusted');
      expect(text).toContain(lang === 'ru' ? '«да»' : '«yes»');
      expect(text).toContain(i18n.t('localLayer.mode.off'));
      // Текст в разметке экранирован (кавычки-ёлочки — нет); сверка по первой фразе.
      expect(html).toContain(text.split('.')[0] as string);
      expect(html).not.toContain('session-carry-');
    },
  );

  it('trusted, unknown or not used → no warning; unknown never guesses', () => {
    for (const next of [
      { folderTrust: 'trusted' as const },
      { folderTrust: 'unknown' as const },
      {},
      {
        folderTrust: 'untrusted' as const,
        used: false,
        mode: 'off' as const,
        reason: 'off' as const,
      },
    ]) {
      const html = render(next);
      expect(html, JSON.stringify(next)).not.toContain('data-testid="local-layer-untrusted"');
      expect(html).toContain('data-testid="local-layer-reason"');
    }
  });
});
