import type { PlatformToolShimReport } from '@agentdeck/contracts';

/**
 * Сводка приходит без проверки схемы (обычное приведение типа в `getGateway`),
 * поэтому её форма проверяется здесь: неполный объект от сервера другой версии
 * не должен ронять весь раздел «Контур» ради одной карточки.
 */
export function isReport(
  report: PlatformToolShimReport | undefined,
): report is PlatformToolShimReport {
  // Счётчики, на которых стоит «вызовов не было», проверяются тоже: без них
  // `undefined > 0` читалось бы как ноль, и незнание выдавалось бы за факт.
  return (
    Boolean(report) &&
    Array.isArray(report?.flaws) &&
    typeof report?.requests === 'number' &&
    typeof report?.calls === 'number' &&
    typeof report?.claimed === 'number'
  );
}
