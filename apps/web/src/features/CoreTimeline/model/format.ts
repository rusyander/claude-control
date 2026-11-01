import type { Verdict } from '@agentdeck/contracts/core/records';

/**
 * Числа и время ленты в языке интерфейса. Токены — целые с разделителем разрядов, деньги — с
 * четырьмя знаками: ход заглушки или короткий шаг стоит доли цента, и `$0.00` прятал бы расход,
 * который ядро посчитало (P43 — показываем ровно его число, не округлённое до нуля).
 */

const localeOf = (language: string): string => (language.startsWith('ru') ? 'ru-RU' : 'en-US');

export function formatCount(value: number, language: string): string {
  return value.toLocaleString(localeOf(language), { maximumFractionDigits: 0 });
}

export function formatUsd(value: number): string {
  return value.toFixed(4);
}

export function formatClock(at: number, language: string): string {
  return new Date(at).toLocaleTimeString(localeOf(language), { hour12: false });
}

/**
 * Вердикт записи проверки строкой: вид и причина словами ядра (перевод исказил бы основание, как и
 * у причин решений, P32). Вердикт — объект, и в шаблон целиком он уходил «[object Object]».
 */
export function verdictLine(verdict: Verdict): string {
  switch (verdict.kind) {
    case 'pass':
      return 'pass';
    case 'pass-flaky':
      return `pass-flaky (${verdict.retries.length})`;
    case 'fail':
    case 'no-verdict':
      return `${verdict.kind}: ${verdict.reason}`;
  }
}
