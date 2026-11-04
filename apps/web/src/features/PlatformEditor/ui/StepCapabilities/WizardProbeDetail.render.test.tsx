import { afterAll, describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { PlatformProbeResult } from '@agentdeck/contracts';
import { i18n } from '@shared/config/i18n';
import { newPlatform } from '@entities/Platform';
import type { PlatformWizardModel } from '../../model/usePlatformWizard';
import { StepAddress } from '../StepAddress/StepAddress';
import { StepCapabilities } from './StepCapabilities';

/**
 * Итог пробы в мастере контура. Сервер собирает причину по-русски, а код к ней восстанавливает
 * разбором (`attachTextCodes`): шаги «Адрес» и «Возможности» показывают её словарём интерфейса.
 * Без перевода английская панель писала «Контур ответил: моделей 3.» (съёмка справки 03.11).
 */

const probe: PlatformProbeResult = {
  outcome: 'ok',
  reachable: true,
  url: 'http://contour.example.com/v1/models',
  detail: 'Контур ответил: моделей 3.',
  detailCode: 'contour-probe-ok',
  detailParams: { count: 3 },
  models: [],
  capabilities: [],
  limits: {},
  notes: ['Заметка без кода'],
  compromises: [],
  checkedAt: '2026-11-03T00:00:00.000Z',
};

const model = {
  draft: newPlatform('demo', 'Demo'),
  probe,
  isBusy: false,
  isProbing: false,
  isValid: true,
  patch: () => {},
  setId: () => {},
  probeNow: async () => {},
} as unknown as PlatformWizardModel;

afterAll(async () => {
  await i18n.changeLanguage('ru');
});

describe('platform wizard: probe detail in the interface language', () => {
  it('english panel → the coded probe detail in English on both steps; uncoded note as is', async () => {
    await i18n.changeLanguage('en');
    for (const html of [
      renderToStaticMarkup(<StepAddress model={model} />),
      renderToStaticMarkup(<StepCapabilities model={model} />),
    ]) {
      expect(html).toContain('The contour answered, models: 3.');
      expect(html).not.toContain('Контур ответил');
    }
    expect(renderToStaticMarkup(<StepCapabilities model={model} />)).toContain('Заметка без кода');
  });

  it('russian panel → the same detail in Russian', async () => {
    await i18n.changeLanguage('ru');
    expect(renderToStaticMarkup(<StepCapabilities model={model} />)).toContain(
      'Контур ответил: моделей 3.',
    );
  });
});
