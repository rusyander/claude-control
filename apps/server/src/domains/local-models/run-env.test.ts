import { describe, it, expect } from 'vitest';
import {
  CLAUDE_TIMEOUT_CAP_MS,
  LOCAL_MAX_OUTPUT_TOKENS,
  LOCAL_REQUEST_FLOOR_MS,
  LOCAL_RUN_ENV_VARS,
  localRequestBudgetMs,
  localRunEnv,
} from './run-env.ts';

describe('окружение прогона Claude на локальной модели', () => {
  it('окно сервера — и окно модели, и окно сжатия; резерв под ответ меньше облачного; вызовы по одному', () => {
    const env = localRunEnv(65_536, 364);
    expect(env).toMatchObject({
      CLAUDE_CODE_MAX_CONTEXT_TOKENS: '65536',
      CLAUDE_CODE_AUTO_COMPACT_WINDOW: '65536',
      CLAUDE_CODE_MAX_OUTPUT_TOKENS: String(LOCAL_MAX_OUTPUT_TOKENS),
      CLAUDE_CODE_MAX_TOOL_USE_CONCURRENCY: '1',
    });
    expect(Object.keys(localRunEnv(1))).toEqual([...LOCAL_RUN_ENV_VARS]);
  });

  it('резерв под ответ оставляет окну место: 8192 из 65536, а не облачные 32000', () => {
    expect(LOCAL_MAX_OUTPUT_TOKENS).toBeLessThan(32_000);
    expect(LOCAL_MAX_OUTPUT_TOKENS * 3).toBeLessThanOrEqual(65_536);
  });

  it('повтор «перегрузки» без предела включён: клиент доживает до подъёма сервера', () => {
    expect(localRunEnv(65_536).CLAUDE_CODE_RETRY_WATCHDOG).toBe('1');
  });

  it('предел ответа одного инструмента — восьмая часть окна, и файл, и MCP', () => {
    const env = localRunEnv(65_536);
    expect(env.CLAUDE_CODE_FILE_READ_MAX_OUTPUT_TOKENS).toBe('8192');
    expect(env.MAX_MCP_OUTPUT_TOKENS).toBe('8192');
    expect(localRunEnv(131_072).MAX_MCP_OUTPUT_TOKENS).toBe('16384');
  });
});

describe('срок ожидания первого байта у Claude Code', () => {
  it('быстрая карта: окно разбирается за минуты — берётся пол в пять минут', () => {
    // 65536 / 364 * 1.5 = 270 с, меньше пола.
    expect(localRequestBudgetMs(65_536, 364)).toBe(LOCAL_REQUEST_FLOOR_MS);
  });

  it('медленный разбор растит срок вместе с окном: 131072 токена на 150 ток/с — 1311 с с запасом', () => {
    expect(localRequestBudgetMs(131_072, 150)).toBe(Math.ceil((131_072 / 150) * 1_500));
    expect(localRequestBudgetMs(131_072, 150)).toBeGreaterThan(LOCAL_REQUEST_FLOOR_MS);
  });

  it('замера нет — считается по осторожной скорости, а не по нулю', () => {
    expect(localRequestBudgetMs(131_072)).toBe(localRequestBudgetMs(131_072, 150));
    expect(localRequestBudgetMs(131_072, 0)).toBe(localRequestBudgetMs(131_072, 150));
  });

  it('больше предела самого Claude Code (30 минут) не просим: он бы его всё равно срезал', () => {
    expect(localRequestBudgetMs(1_000_000, 50)).toBe(CLAUDE_TIMEOUT_CAP_MS);
  });

  it('все четыре срока в окружении — один расчёт; общий запрос ждёт дольше первого байта', () => {
    const env = localRunEnv(131_072, 150);
    const budget = String(localRequestBudgetMs(131_072, 150));
    expect(env.CLAUDE_STREAM_FIRST_BYTE_TIMEOUT_MS).toBe(budget);
    expect(env.CLAUDE_STREAM_IDLE_TIMEOUT_MS).toBe(budget);
    expect(env.CLAUDE_BYTE_STREAM_IDLE_TIMEOUT_MS).toBe(budget);
    expect(Number(env.API_TIMEOUT_MS)).toBeGreaterThan(Number(budget));
  });
});
