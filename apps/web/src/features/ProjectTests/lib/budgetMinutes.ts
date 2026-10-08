/** Минуты бюджета из поля; мусор и ноль значат «набирать нечего». */
export function budgetMinutes(value: string): number | undefined {
  const minutes = Number(value.replace(',', '.').trim());
  return Number.isFinite(minutes) && minutes > 0 ? Math.round(minutes) : undefined;
}
