export interface DecisionTexts {
  truncated: string;
  alreadyDecided: string;
  gone: string;
  failed: (message: string) => string;
}

/**
 * Отказ решения по карточке — словами, а не статусом. Телефон с токеном решает
 * карточку наравне с окном панели (сервер принимает Bearer без Origin), поэтому
 * особого «решите на компьютере» нет: кто первый решил, того и решение, второй
 * получит «уже решено». Прочий отказ (в том числе 403) — текстом сервера.
 */
export function decisionProblem(
  error: { status?: number; code?: string; message?: string },
  texts: DecisionTexts,
): string {
  if (error.status === 409 && error.code === 'preview_truncated') return texts.truncated;
  if (error.status === 409) return texts.alreadyDecided;
  if (error.status === 404) return texts.gone;
  return texts.failed(error.message ?? '');
}
