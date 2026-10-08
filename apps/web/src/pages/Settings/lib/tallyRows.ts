import type { SieveTally } from '@agentdeck/contracts/sieves';
import { SIEVE_CLASSES } from '@agentdeck/contracts/sieves';

/** Сколько последних месяцев счёта показывать: дольше — уже не про нынешние сита. */
export const TALLY_MONTHS = 6;

/** Строки счёта: месяц × класс, только классы, где что-то было. */
export function tallyRows(tally: SieveTally) {
  return Object.keys(tally)
    .sort()
    .reverse()
    .slice(0, TALLY_MONTHS)
    .flatMap((month) =>
      SIEVE_CLASSES.flatMap((cls) => {
        const cell = tally[month]?.[cls];
        return cell ? [{ month, cls, ...cell }] : [];
      }),
    );
}
