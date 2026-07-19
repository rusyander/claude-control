/** Склейка классов: пустые и ложные значения отбрасываются. */
export function cn(...values: Array<string | false | undefined | null>): string {
  return values.filter(Boolean).join(' ');
}
