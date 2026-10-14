import { blockLang } from '@agentdeck/contracts/brand';
import { OWNER_POINT_ID } from '@agentdeck/contracts/quality-floor';
import { EVIDENCE_MIN, scanSieveBlocks, type SieveReportRow } from '@agentdeck/contracts/sieves';
import { serverText } from '../../../lib/server-texts/server-texts.ts';

/**
 * Пробелы следа требований (U2) — строками недостающего доставки: их получает
 * напоминание той же сессии группы, и только оставшееся после напоминаний
 * ложится на карточку. «Готово» без отчёта по словам владельца не бывает:
 * пересказ и пропуск условия — ровно то, что ушло мимо в живом ревью 12.10.
 *
 * `required` — у группы есть блок слов владельца; без него пунктов не задано,
 * и судить нечего.
 */
export function ownerCoverageGaps(
  rows: readonly SieveReportRow[] | undefined,
  required: boolean,
): string[] {
  if (!required) return [];
  const points = (rows ?? []).filter((row) => OWNER_POINT_ID.test(row.id));
  if (points.length === 0) {
    return [serverText('delivery-gap-owner-unreported', { lang: blockLang('sieves') })];
  }
  const gaps: string[] = [];
  for (const row of points) {
    if (row.evidence.length < EVIDENCE_MIN) {
      gaps.push(serverText('delivery-gap-owner-no-evidence', { point: row.id }));
    } else if (row.status === 'fail') {
      gaps.push(serverText('delivery-gap-owner-failed', { point: row.id, evidence: row.evidence }));
    }
  }
  return gaps;
}

/**
 * Блок следа требований написан, но панель его не разобрала (T21): схема чужая —
 * `{"points":[…]}`, числовые `id`, статус `done`. Пункты владельца остаются «не
 * разобраны», а не «выполнены»: ревью по ссылке просит ту же сессию переписать
 * блок один раз. Блока нет вовсе — то же самое: слова владельца заданы, а след не
 * написан. Читаемый блок сит без строк `owner-N` здесь не судится — это пробел
 * доставки «не отчитано».
 */
export function ownerTraceUnparsed(text: string, required: boolean): boolean {
  if (!required) return false;
  const scan = scanSieveBlocks(text);
  if (scan.rows.some((row) => OWNER_POINT_ID.test(row.id))) return false;
  return scan.rejected > 0 || scan.rows.length === 0;
}
