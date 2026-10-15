import { beforeAll, describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { LocalLayerFit } from '@agentdeck/contracts/local-models';
import { i18n } from '@shared/config/i18n';
import { LocalLayerNotice } from './LocalLayerNotice';

/**
 * Строка о замороженных описаниях MCP: разговор начат до подгрузки по требованию, и Claude Code
 * держит его набор инструментов. Видна в том разговоре, чей запрос замерен, и вместе со строкой
 * о слое, не влезающем в окно, если обе правда.
 */

const layer: LocalLayerFit = {
  tokens: 71_153,
  context: 131_072,
  limit: 126_976,
  fits: true,
  at: 1,
  session: 'old',
  frozenTools: 48_120,
};

const render = (fit: LocalLayerFit, session?: string): string =>
  renderToStaticMarkup(<LocalLayerNotice layer={fit} {...(session ? { session } : {})} />);

beforeAll(async () => {
  await i18n.changeLanguage('ru');
});

describe('строка о замороженных описаниях MCP', () => {
  it('тот разговор: строка с числом токенов и выходом — новый чат', () => {
    const html = render(layer, 'old');
    expect(html).toContain('data-testid="local-frozen-notice"');
    expect(html).toContain('48');
    expect(html).toContain('В новом чате');
  });

  it('другой разговор или карточка сервера без разговора — строки нет', () => {
    expect(render(layer, 'new')).toBe('');
    expect(render(layer)).toBe('');
  });

  it('слой ещё и не влезает в окно — обе строки', () => {
    const html = render({ ...layer, fits: false, context: 65_536, limit: 61_440 }, 'old');
    expect(html).toContain('data-testid="local-layer-notice"');
    expect(html).toContain('data-testid="local-frozen-notice"');
  });
});
