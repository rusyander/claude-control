let counter = 0;
/** Следующий идентификатор строки формы (монотонный, к данным отношения не имеет). */
export function nextRowId(): number {
  counter += 1;
  return counter;
}
