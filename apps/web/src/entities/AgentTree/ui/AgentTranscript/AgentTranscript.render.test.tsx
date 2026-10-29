import { beforeAll, describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { AgentStep, AgentTranscript as Transcript } from '@agentdeck/contracts';
import { chatKeys } from '@entities/Chat';
import { i18n } from '@shared/config/i18n';
import { agentTreeKeys } from '../../api/agentTreeApi';
import { AgentStepRow } from './AgentStepRow';
import { AgentTranscript } from './AgentTranscript';

/**
 * Ход агента справа — что видит человек: у вызова время, длительность, полный
 * размер результата и отказ хука с причиной; у первого шага ответа — его
 * расход и модель; у главного агента — тот же вид, итоги по всему файлу и
 * точное «шаги a–b из M». Данные — в кэше запросов, как их кладёт хук.
 */
const call = (over: Partial<AgentStep> = {}): AgentStep => ({
  kind: 'tool',
  name: 'Read',
  summary: '/a.ts',
  at: '2026-10-26T08:01:00.000Z',
  result: 'ok',
  ...over,
});

function step(value: AgentStep): string {
  return renderToStaticMarkup(
    <ol>
      <AgentStepRow step={value} />
    </ol>,
  );
}

function pane(chatId: string, agentId: string, data: Transcript): string {
  const client = new QueryClient();
  client.setQueryData(chatKeys.progress(chatId), { tasks: [], agents: [] });
  client.setQueryData(agentTreeKeys.transcript(chatId, agentId, { limit: 200 }), data);
  return renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <AgentTranscript chatId={chatId} agentId={agentId} onClose={() => undefined} />
    </QueryClientProvider>,
  );
}

beforeAll(async () => {
  await i18n.changeLanguage('ru');
});

describe('AgentStepRow — шаг хода', () => {
  it('вызов: время, длительность, полный размер результата', () => {
    const html = step(call({ durationMs: 72_000, resultChars: 12_000 }));
    expect(html).toMatch(/data-step-meta[^>]*>\d{2}:01:00 · 1м 12с · 12\s000 симв\.</);
  });

  it('короткий вызов — в миллисекундах', () => {
    expect(step(call({ durationMs: 340, resultChars: 2 }))).toContain('340 мс');
  });

  it('отказ хука — метка «отказ хука» и причина текстом, вместо окна результата', () => {
    const html = step(
      call({
        name: 'Bash',
        isError: true,
        denial: '[destructive-guard] rm -rf запрещён',
        result: 'PreToolUse:Bash hook error: [destructive-guard] rm -rf запрещён',
      }),
    );
    expect(html).toContain('data-step-denied');
    expect(html).toContain('>отказ хука<');
    expect(html).toContain('data-step-denial="true">[destructive-guard] rm -rf запрещён</p>');
    expect(html).not.toContain('<pre');
    expect(html).not.toContain('>ошибка<');
  });

  it('ошибка без отказа — «ошибка» и результат', () => {
    const html = step(call({ isError: true, result: 'exit 1' }));
    expect(html).toContain('>ошибка<');
    expect(html).toContain('<pre');
  });

  it('оборван паузой — «прервано» своим цветом, не «ошибка»', () => {
    const html = step(call({ result: '[Tool call interrupted by pause]', interrupted: true }));
    expect(html).toContain('data-step-interrupted');
    expect(html).toContain('>прервано<');
    expect(html).toMatch(/class="[^"]*toolInterrupted/);
    expect(html).not.toContain('>ошибка<');
    expect(html).not.toMatch(/class="[^"]*toolError/);
  });

  it('первый шаг ответа — расход этого ответа и модель', () => {
    const html = step({
      kind: 'thinking',
      text: 'план',
      usage: { input: 100, output: 10, cacheRead: 1000, cacheCreation: 50 },
      model: 'claude-opus-4-1-20250805',
    });
    expect(html).toContain(
      'ответ модели: вход 100 · из кэша 1.0k · в кэш 50 · ответ 10 · opus-4-1',
    );
  });
});

describe('AgentTranscript — ход главного агента', () => {
  const data: Transcript = {
    agentId: 'main',
    model: 'claude-opus-4-1',
    prompt: 'Проверь отчёты',
    steps: [call({ denial: 'нельзя', isError: true }), call({ name: 'Bash' })],
    total: 2500,
    hasMore: true,
    start: 2498,
    toolCalls: 2500,
    tokens: { input: 2100, output: 210, cacheRead: 21000, cacheCreation: 55 },
    anomalies: {
      denials: 1,
      errors: 0,
      repeatedReads: [{ path: '/a.ts', count: 2 }],
      largeResults: 0,
    },
  };

  it('свой заголовок, итоги по всему файлу, странности, точное окно «шаги a–b из M»', () => {
    const html = pane('s-exact', 'main', data);
    expect(html).toContain('data-agent-pane="main"');
    expect(html).toContain('Ход главного агента');
    expect(html).toContain('Только чтение: ход пишет сам CLI');
    expect(html).toContain(
      'Всего: вызовов 2500 · вход 2.1k · из кэша 21.0k · в кэш 55 · ответ 210',
    );
    expect(html).toContain('отказов хуков 1 · повторных чтений 1');
    expect(html).toContain('Шаги 2499–2500 из 2500');
    expect(html).toContain('Показать раньше');
    expect(html).toContain('start="2499"');
    expect(html).not.toContain('data-agent-pane-interrupted');
  });

  it('оборванные паузой вызовы — своей строкой, отдельно от странностей', () => {
    const html = pane('s-cut', 'main', {
      ...data,
      anomalies: { denials: 0, errors: 0, interrupted: 3, repeatedReads: [], largeResults: 0 },
    });
    expect(html).toContain('data-agent-pane-interrupted');
    expect(html).toContain('прервано паузой 3');
    expect(html).not.toContain('data-agent-pane-anomalies');
  });

  it('ранние шаги ушли из памяти — сказано, сколько, и «раньше» нет', () => {
    const html = pane('s-exact', 'main', { ...data, hasMore: false, start: 50_000, total: 50_002 });
    expect(html).toContain('Первые 50000 шагов в памяти панели не хранятся');
    expect(html).not.toContain('Показать раньше');
  });
});
