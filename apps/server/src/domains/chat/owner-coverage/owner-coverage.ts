import { blockLang } from '@agentdeck/contracts/brand';
import { OWNER_POINT_ID, TASK_POINT_ID } from '@agentdeck/contracts/quality-floor';
import {
  EVIDENCE_MIN,
  flipWithoutProof,
  scanSieveBlocks,
  type SieveReportRow,
} from '@agentdeck/contracts/sieves';
import { serverText } from '../../../lib/server-texts/server-texts.ts';

/**
 * Почему переворот fail → pass не принят — текстом (`flipWithoutProof`): им говорят
 * и пробел сита (`sieveDeliveryGaps`), и пробел пункта владельца.
 */
export function flipWhy(kind: string, was: string): string {
  if (kind === 'mark') return serverText('sieve-flip-mark', {});
  if (kind === 'red') return serverText('sieve-flip-red', {});
  return serverText('sieve-flip-same', { was });
}

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
  /**
   * Строки, которые судья сит записал заметкой (`sieveDeliveryGaps().noted`):
   * «не проверено» и «не из-за ветки» у пункта владельца — заметка в описании
   * MR, а не «не выполнено». Без этого одна и та же строка g3 25.10 шла в
   * напоминании и заметкой, и держащим пробелом — напоминание не могло дойти.
   */
  noted: readonly string[] = [],
  /**
   * Метки, которые судья сит не принял (`sieveDeliveryGaps().rejected`): пробел
   * называет причину, иначе группа пересказывает то же доказательство (g3 25.10).
   */
  rejected: Readonly<Record<string, string>> = {},
): string[] {
  return pointCoverageGaps('owner', rows, required, noted, rejected);
}

/**
 * Пробелы следа задач (`taskCoverageLine`): строки `task-N` судятся так же, как
 * пункты владельца. `required` — группе отдали строку следа задач (`taskTrace`);
 * группе, которой её не давали, отчитываться не о чем.
 */
export function taskCoverageGaps(
  rows: readonly SieveReportRow[] | undefined,
  required: boolean,
  noted: readonly string[] = [],
  rejected: Readonly<Record<string, string>> = {},
): string[] {
  return pointCoverageGaps('task', rows, required, noted, rejected);
}

const POINT_ID = { owner: OWNER_POINT_ID, task: TASK_POINT_ID } as const;

function pointCoverageGaps(
  kind: keyof typeof POINT_ID,
  rows: readonly SieveReportRow[] | undefined,
  required: boolean,
  noted: readonly string[],
  rejected: Readonly<Record<string, string>>,
): string[] {
  if (!required) return [];
  const points = (rows ?? []).filter((row) => POINT_ID[kind].test(row.id));
  if (points.length === 0) {
    return [serverText(`delivery-gap-${kind}-unreported`, { lang: blockLang('sieves') })];
  }
  const gaps: string[] = [];
  for (const row of points) {
    // fail → pass с тем же доказательством или с «красный» в нём (g3 25.10, owner-4).
    const flip = flipWithoutProof(row);
    if (row.evidence.length < EVIDENCE_MIN) {
      gaps.push(serverText(`delivery-gap-${kind}-no-evidence`, { point: row.id }));
    } else if (flip) {
      const why = flipWhy(flip, row.was?.evidence.slice(0, 300) ?? '');
      gaps.push(serverText(`delivery-gap-${kind}-flip`, { point: row.id, why }));
    } else if (row.status === 'fail' && !noted.includes(row.id)) {
      const why = rejected[row.id];
      gaps.push(
        why
          ? serverText(`delivery-gap-${kind}-note-rejected`, {
              point: row.id,
              evidence: row.evidence,
              why,
            })
          : serverText(`delivery-gap-${kind}-failed`, { point: row.id, evidence: row.evidence }),
      );
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
