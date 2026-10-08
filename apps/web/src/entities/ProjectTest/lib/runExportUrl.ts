/**
 * PDF рядом с md и csv: отчёт уходит приёмке и заказчику, а туда посылают не
 * markdown. Рисует его браузер, найденный на машине, — нет браузера, сервер
 * честно отвечает отказом, и ссылка приводит к его тексту, а не к битому файлу.
 */
export type RunExportFormat = 'md' | 'csv' | 'pdf';

/**
 * Адрес отчёта по одному прогону. Отдельно от выгрузки кейсов: там срез набора
 * «как он выглядит сейчас», здесь событие «вот что было в этот раз».
 *
 * PDF живёт СВОИМ маршрутом, а не форматом выгрузки: печать асинхронная и
 * отвечает отказом, когда печатать нечем. Общий маршрут выгрузки такого формата
 * не знает и на `format=pdf` отвечает 400 — ссылка приводила бы к отказу
 * «формат: md, csv или html» вместо файла.
 */
export function runExportUrl(
  path: string | undefined,
  id: string,
  format: RunExportFormat,
): string {
  if (format === 'pdf') {
    const print = new URLSearchParams({ path: path ?? '', id });
    return `/api/project-tests/run/pdf?${print.toString()}`;
  }
  const query = new URLSearchParams({ path: path ?? '', id, format });
  return `/api/project-tests/run/export?${query.toString()}`;
}
