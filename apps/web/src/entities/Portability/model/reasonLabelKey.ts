/** Ключ перевода причины. Причина без перевода показывает свой код, а не пустоту. */
export function reasonLabelKey(reason: string): string {
  return `portability.fidelity.reason.${reason}`;
}
