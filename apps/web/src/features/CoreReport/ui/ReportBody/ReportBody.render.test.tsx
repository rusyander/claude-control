import { afterAll, describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { FinalReport } from '@agentdeck/contracts/core/report';
import { i18n } from '@shared/config/i18n';
import { ReportBody } from './ReportBody';

/**
 * Состояние единицы в отчёте — словами языка панели: сырое `ready-to-publish` стояло в русской
 * строке «… — ready-to-publish, ветка …» (кадр отчёта ядра, проход s10).
 */

const TASK = '01900000-0000-7000-8000-000000000001';

function render(state: string): string {
  const report: FinalReport = {
    taskId: TASK,
    at: 'ended',
    outcome: 'ready-to-publish',
    units: [
      { unitId: '01900000-0000-7000-8000-000000000002', name: 'web', state, branch: 'core/web' },
    ],
    requirements: [],
    forks: [],
    unverified: [],
    residuals: [],
    suggestions: [],
    lateAnswers: [],
  };
  return renderToStaticMarkup(<ReportBody report={report} />);
}

describe('ReportBody — состояние единицы', () => {
  afterAll(async () => {
    await i18n.changeLanguage('ru');
  });

  it('ru: the unit state is in Russian words, never the raw machine state', async () => {
    await i18n.changeLanguage('ru');
    const markup = render('ready-to-publish');
    expect(markup).toContain('web — готова к публикации, ветка core/web');
    expect(markup).not.toContain('ready-to-publish,');
  });

  it('en: the same state in English words', async () => {
    await i18n.changeLanguage('en');
    expect(render('blocked')).toContain('web — waiting for another unit, branch core/web');
  });

  it('a state the panel does not know yet is shown as is', async () => {
    await i18n.changeLanguage('ru');
    expect(render('brand-new')).toContain('web — brand-new, ветка core/web');
  });
});
