import type { ProjectTestStepResult, ProjectTestManualSession } from '@agentdeck/contracts';

/** То, что уже отмечено по поинту: с ним человек и возвращается к пройденному. */
export interface SavedPoint {
  steps: ProjectTestStepResult[];
  note: string;
  attachments: string[];
}

/**
 * Отмеченное по поинту из сессии.
 *
 * Переход на другой поинт обязан класть в форму ЕГО отметки, а не остатки
 * прошлого: чужая заметка, приехавшая на новый кейс, — худший вид испорченного
 * результата, потому что выглядит она как настоящая.
 */
export function savedFor(
  session: ProjectTestManualSession | undefined,
  pointId: string | undefined,
): SavedPoint {
  const saved = session?.results.find((item) => item.pointId === pointId);
  return {
    steps: saved?.steps ?? [],
    note: saved?.note ?? '',
    attachments: saved?.attachments ?? [],
  };
}
