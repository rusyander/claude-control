import { beforeAll, describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { UsageLimits } from '@agentdeck/contracts';
import { i18n } from '@shared/config/i18n';
import { UsageLimitsView } from './UsageLimitsMeter';

/**
 * Блок лимитов в боковой панели: три окна с процентом ровно той точности, что
 * дал сервер, полосой и сбросом; при неудачной попытке — прежние окна с пометкой
 * «устарело»; окон нет — строка с причиной. Денег нет ни в одном виде.
 */

const now = new Date(2026, 9, 19, 15, 0).getTime();
const ok: UsageLimits = {
  status: 'ok',
  source: 'oauth',
  observedAt: now - 20_000,
  windows: [
    {
      id: 'session',
      kind: 'session',
      percent: 68,
      resetsAt: new Date(2026, 9, 19, 20, 10).getTime(),
      active: true,
    },
    { id: 'weekly', kind: 'weekly', percent: 42.137, resetsAt: new Date(2026, 9, 23, 9).getTime() },
    {
      id: 'weekly:Opus',
      kind: 'weekly-model',
      model: 'Opus',
      percent: 91,
      resetsAt: new Date(2026, 9, 23, 9).getTime(),
    },
  ],
};

const render = (limits: UsageLimits, isCollapsed = false): string =>
  renderToStaticMarkup(<UsageLimitsView limits={limits} now={now} isCollapsed={isCollapsed} />);

beforeAll(async () => {
  await i18n.changeLanguage('ru');
});

describe('блок лимитов подписки', () => {
  it('три окна: подпись, процент как у сервера, сброс, полоса по проценту', () => {
    const html = render(ok);
    expect(html).toContain('data-usage-limits');
    expect(html).toContain('Сессия (5 ч)');
    expect(html).toContain('Неделя · Opus');
    expect(html).toContain('>68%<');
    expect(html).not.toContain('68.000');
    expect(html).toContain('>42.137%<');
    expect(html).toContain('сброс 20:10');
    expect(html).toContain('width:68%');
    expect(html.match(/role="meter"/g)).toHaveLength(3);
    expect(html).toContain('aria-valuenow="68"');
  });

  it('тон: 91% — опасность, 68% — обычный', () => {
    const html = render(ok);
    expect(html).toMatch(/data-tone="danger"[^>]*data-limit-id="weekly:Opus"/);
    expect(html).toMatch(/data-tone="normal"[^>]*data-limit-id="session"/);
  });

  it('свёрнутая панель — только целые проценты, точное значение в подсказке', () => {
    const html = render(ok, true);
    expect(html).toContain('>42%<');
    expect(html).toContain('42.137%');
    expect(html).not.toContain('Лимиты подписки</span>');
  });

  it('неудачная попытка с прежними окнами — окна на месте и пометка «устарело»', () => {
    const html = render({ ...ok, status: 'rate-limited' });
    expect(html).toContain('устарело');
    expect(html).toContain('data-stale="true"');
    expect(html).toContain('Сервер Anthropic просит подождать');
  });

  it('окон нет — строка с причиной, без полос', () => {
    const html = render({ status: 'token-expired', windows: [], observedAt: null, source: null });
    expect(html).toContain('Вход Claude Code истёк');
    expect(html).not.toContain('role="meter"');
  });

  it('денег нет ни в одном виде', () => {
    expect(render(ok)).not.toMatch(/\$|USD|долл/i);
  });
});
