/** Короткая строка для экрана и полный текст со стеком для буфера обмена. */
export function describe(error: unknown): { line: string; full: string } {
  if (error instanceof Error) {
    const line = error.message || error.name;
    return { line, full: `${error.name}: ${error.message}\n${error.stack ?? ''}`.trim() };
  }
  const line = String(error);
  return { line, full: line };
}
