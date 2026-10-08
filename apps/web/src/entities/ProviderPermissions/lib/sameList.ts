/** Списки совпадают с точностью до порядка — по нему считается «есть правки». */
export const sameList = (a: string[], b: string[]): boolean =>
  a.length === b.length && a.every((item, index) => item === b[index]);
