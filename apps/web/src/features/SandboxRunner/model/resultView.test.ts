import { describe, it, expect } from 'vitest';
import type { ProbeResult } from '@entities/Sandbox';
import { COLLAPSE_CHARS, COLLAPSE_LINES, resultView } from './resultView';

const probe = (patch: Partial<ProbeResult>): ProbeResult => ({
  fixtureId: 'harmless',
  exitCode: 0,
  stdout: '',
  stderr: '',
  decision: 'pass',
  matchesExpectation: true,
  durationMs: 12,
  timedOut: false,
  ...patch,
});

/**
 * Кейс config-resources-005: успешный прогон хука обязан показать то, что
 * получит Claude Code, — вывод и код выхода. Раньше строка «пропустил · 12 мс»
 * прятала оба, хотя сервер их возвращал.
 */
describe('resultView — что показать под прогоном хука', () => {
  it('код 0 и вывод успешного прогона видны', () => {
    const view = resultView(probe({ stdout: '1\n' }));
    expect(view.exitCode).toBe(0);
    expect(view.outputs).toEqual([{ stream: 'stdout', text: '1', lines: 1, collapsed: false }]);
  });

  it('stdout и stderr идут отдельными потоками, пустой поток не рисуется', () => {
    const view = resultView(probe({ stdout: 'лог\n', stderr: '  \n' }));
    expect(view.outputs.map((output) => output.stream)).toEqual(['stdout']);
    const both = resultView(probe({ stdout: 'a', stderr: 'b' }));
    expect(both.outputs.map((output) => output.stream)).toEqual(['stdout', 'stderr']);
  });

  it('код 2 показывается как есть', () => {
    expect(resultView(probe({ exitCode: 2, decision: 'block' })).exitCode).toBe(2);
  });

  it('незапустившийся процесс (-1) и таймаут кода выхода не имеют', () => {
    expect(resultView(probe({ exitCode: -1, decision: 'error' })).exitCode).toBeUndefined();
    expect(resultView(probe({ exitCode: 0, timedOut: true })).exitCode).toBeUndefined();
  });

  it('длинный вывод свёрнут — по строкам и по длине', () => {
    const manyLines = Array.from({ length: COLLAPSE_LINES + 1 }, (_, i) => `line ${i}`).join('\n');
    const byLines = resultView(probe({ stdout: manyLines })).outputs[0];
    expect(byLines?.collapsed).toBe(true);
    expect(byLines?.lines).toBe(COLLAPSE_LINES + 1);

    const exactLines = Array.from({ length: COLLAPSE_LINES }, () => 'x').join('\n');
    expect(resultView(probe({ stdout: exactLines })).outputs[0]?.collapsed).toBe(false);

    const wide = 'x'.repeat(COLLAPSE_CHARS + 1);
    expect(resultView(probe({ stdout: wide })).outputs[0]?.collapsed).toBe(true);
    expect(resultView(probe({ stdout: 'x'.repeat(COLLAPSE_CHARS) })).outputs[0]?.collapsed).toBe(
      false,
    );
  });

  it('хвостовые переводы строки не считаются выводом, внутренние сохраняются', () => {
    const view = resultView(probe({ stdout: 'a\r\nb\r\n\r\n' })).outputs[0];
    expect(view?.text).toBe('a\r\nb');
    expect(view?.lines).toBe(2);
  });
});
