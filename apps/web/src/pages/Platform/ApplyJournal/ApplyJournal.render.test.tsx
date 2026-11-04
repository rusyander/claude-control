import { afterEach, describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { PlatformApplyTarget } from '@agentdeck/contracts';
import { PLATFORM_ASSISTANT_TARGET } from '@agentdeck/contracts';
import { i18n } from '@shared/config/i18n';
import { ApplyJournal } from './ApplyJournal';

/**
 * Журнал применения под английским интерфейсом. Найдено живьём: строка
 * читалась «Ассистент панели written» — имя ассистента сервер пишет по-русски,
 * а журнал брал его как есть, мимо `applyTargetTitle`. Цель CLI зовётся своим
 * торговым именем и не переводится.
 */

const target = (targetId: string, title: string): PlatformApplyTarget => ({
  targetId,
  title,
  supported: true,
  filePath: targetId === PLATFORM_ASSISTANT_TARGET ? '' : `C:/home/.${targetId}/settings.json`,
  plan: [],
  conflicts: [],
  applied: true,
  appliedAt: '2026-11-03T10:00:00.000Z',
});

const TARGETS = [
  target(PLATFORM_ASSISTANT_TARGET, 'Ассистент панели'),
  target('claude', 'Claude Code'),
];

const textOf = (html: string): string => html.replace(/<[^>]+>/g, ' ');

afterEach(async () => {
  await i18n.changeLanguage('ru');
});

describe('журнал применения', () => {
  it('en: ассистент назван по-английски, ни одной кириллической буквы', async () => {
    await i18n.changeLanguage('en');
    const text = textOf(
      renderToStaticMarkup(
        <ApplyJournal targets={TARGETS} onRollback={() => {}} isPending={false} />,
      ),
    );
    expect(text).toContain('Panel assistant written');
    expect(text).toContain('Claude Code written');
    expect(text).not.toMatch(/[А-Яа-яЁё]/);
  });

  it('ru: ассистент тем же именем, что пишет сервер', async () => {
    await i18n.changeLanguage('ru');
    const text = textOf(
      renderToStaticMarkup(
        <ApplyJournal targets={TARGETS} onRollback={() => {}} isPending={false} />,
      ),
    );
    expect(text).toContain('Ассистент панели');
  });
});
