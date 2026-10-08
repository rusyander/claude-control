/** Решение по карточке, которое сервер отверг навсегда: повтор не поможет. */
export function isFinalRefusal(error: { status?: number; code?: string }): boolean {
  return error.status === 409 || error.status === 404;
}
