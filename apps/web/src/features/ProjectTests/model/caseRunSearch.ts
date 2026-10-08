/**
 * Адрес записи прогона из истории кейса: вкладка прогонов, раскрытый прогон и
 * ПРОЕКТ. Карточка кейса живёт и в окне тестов чата, где проект — каталог
 * чата, а раздел «Тестирование» помнит свой выбор; без проекта ссылка вела в
 * историю чужого проекта, где такого прогона нет, и раздел молчал.
 */
export function caseRunSearch(
  projectPath: string | undefined,
  runId: string,
): { tab: 'runs'; run: string; project?: string } {
  return { tab: 'runs', run: runId, ...(projectPath ? { project: projectPath } : {}) };
}
