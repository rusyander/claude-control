import { afterAll, describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { PanelActionPreview, PanelPendingAction } from '@agentdeck/contracts/panel-agent';
import { i18n } from '@shared/config/i18n';
import { PendingActionCard } from './PendingActionCard';

/**
 * Двуязычные данные карточки (параметры сводки, поле, дифф) — стороной
 * языка окна. Кадр справки 27.09: английская карточка показывала
 * русские данные, потому что сервер клал в `value` только ru.
 */

const bilingual: PanelActionPreview = {
  summary: 'Изменить настройки разделения проекта «Скриншоты»',
  summaryCode: 'summary-project-split-settings',
  summaryParams: { project: 'Скриншоты' },
  summaryParamsEn: { project: 'Screenshots' },
  fields: [
    {
      label: 'Сообщение',
      labelCode: 'label-message',
      value: '1. Скриншоты',
      valueEn: '1. Screenshots',
    },
  ],
  diff: '+  "review #1: Скриншоты"',
  diffEn: '+  "review #1: Screenshots"',
};

/** Запись до вариантов: только русская сторона. */
const legacy: PanelActionPreview = {
  summary: bilingual.summary,
  summaryCode: bilingual.summaryCode,
  summaryParams: bilingual.summaryParams,
  fields: [{ ...bilingual.fields[0]!, valueEn: undefined }],
  diff: bilingual.diff,
};

const pending = (preview: PanelActionPreview): PanelPendingAction => ({
  id: 'p-1',
  name: 'save_project_split_settings',
  risk: 'change',
  preview,
  createdAt: '2026-09-27T10:00:00.000Z',
  expiresAt: '2026-09-27T10:05:00.000Z',
});

async function render(language: string, preview: PanelActionPreview): Promise<string> {
  await i18n.changeLanguage(language);
  return renderToStaticMarkup(
    <PendingActionCard
      pending={pending(preview)}
      isDeciding={false}
      onDecide={() => {}}
      autoFocus={false}
    />,
  );
}

afterAll(async () => {
  await i18n.changeLanguage('ru');
});

describe('карточка подтверждения — двуязычные данные на языке окна', () => {
  it('английское окно: сводка, поле и дифф — английской стороной', async () => {
    const html = await render('en', bilingual);

    expect(html).toContain('Change the split settings of project “Screenshots”');
    expect(html).toContain('1. Screenshots');
    expect(html).toContain('review #1: Screenshots');
    expect(html).not.toContain('Скриншоты');
  });

  it('русское окно: все три — русской стороной', async () => {
    const html = await render('ru', bilingual);

    expect(html).toContain('Изменить настройки разделения проекта «Скриншоты»');
    expect(html).toContain('1. Скриншоты');
    expect(html).toContain('review #1: Скриншоты');
    expect(html).not.toContain('Screenshots');
  });

  it('старая запись без английской стороны — английское окно показывает её как есть', async () => {
    const html = await render('en', legacy);

    expect(html).toContain('Change the split settings of project “Скриншоты”');
    expect(html).toContain('1. Скриншоты');
    expect(html).toContain('review #1: Скриншоты');
  });
});
