import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ProbeResult } from '@entities/Sandbox';
import '@shared/config/i18n/instance';
import { ResultRow } from './ResultRow';

const probe = (patch: Partial<ProbeResult>): ProbeResult => ({
  fixtureId: 'harmless',
  exitCode: 0,
  stdout: '',
  stderr: '',
  decision: 'pass',
  matchesExpectation: true,
  durationMs: 131,
  timedOut: false,
  ...patch,
});

const render = (result: ProbeResult): string =>
  renderToStaticMarkup(<ResultRow result={result} title="Безобидная команда" />);

/**
 * Строка результата песочницы с настоящим русским словарём: код выхода рядом с
 * решением, короткий вывод открыт, длинный — под раскрытием с числом строк.
 */
describe('ResultRow — строка прогона хука', () => {
  it('успешный прогон показывает код 0 и вывод', () => {
    const html = render(probe({ stdout: '1\n' }));
    expect(html).toContain('код выхода 0');
    expect(html).toMatch(/data-stream="stdout"[^>]*>1<\/pre>/);
    expect(html).not.toContain('<details');
  });

  it('длинный вывод свёрнут, в подписи поток и число строк', () => {
    const stdout = Array.from({ length: 12 }, (_, i) => `шаг ${i}`).join('\n');
    const html = render(probe({ stdout }));
    const details = html.indexOf('<details');
    expect(details).toBeGreaterThan(-1);
    expect(html).toContain('stdout · 12 строк');
    expect(html.indexOf('шаг 11')).toBeGreaterThan(details);
  });

  it('незапустившийся хук кода выхода не показывает', () => {
    const html = render(probe({ exitCode: -1, decision: 'error', stderr: 'spawn ENOENT' }));
    expect(html).not.toContain('код выхода');
    expect(html).toMatch(/data-stream="stderr"[^>]*>spawn ENOENT<\/pre>/);
  });
});
