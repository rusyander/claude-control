import { describe, expect, it } from 'vitest';
import { runExportUrl } from '../lib/runExportUrl';
import { releaseExportUrl } from '../lib/releaseExportUrl';

/**
 * Адреса отчётов файлом.
 *
 * Проверяется ровно одно, и не зря: печать живёт СВОИМ маршрутом, а общая
 * выгрузка формата `pdf` не знает и отвечает на него отказом. Ссылка, собранная
 * по общему правилу, приводила бы человека к тексту «формат: md, csv или html»
 * вместо файла — и заметить это можно было только руками.
 */
describe('project-tests: адреса отчётов файлом', () => {
  it('PDF прогона идёт на маршрут печати, а не в общую выгрузку', () => {
    const url = runExportUrl('C:/work/app', 'run-1', 'pdf');

    expect(url).toContain('/api/project-tests/run/pdf?');
    expect(url).not.toContain('format=pdf');
    expect(url).toContain('id=run-1');
  });

  it('md и csv прогона идут общей выгрузкой', () => {
    expect(runExportUrl('C:/work/app', 'run-1', 'md')).toContain('/api/project-tests/run/export?');
    expect(runExportUrl('C:/work/app', 'run-1', 'csv')).toContain('format=csv');
  });

  it('документ готовности печатается тем же путём', () => {
    const pdf = releaseExportUrl('C:/work/app', '1.4', 'pdf');
    const md = releaseExportUrl('C:/work/app', '1.4', 'md');

    expect(pdf).toContain('/api/project-tests/release/pdf?');
    expect(pdf).not.toContain('format=pdf');
    expect(md).toContain('/api/project-tests/release/export?');
    expect(md).toContain('release=1.4');
  });

  // Язык экрана едет в ссылке: смена языка доходит до интерфейса раньше, чем PATCH
  // настроек до сервера, и файл, выгруженный в этот миг, выходил на старом языке.
  it('каждая ссылка файлом несёт язык экрана; без языка — параметра нет', () => {
    const urls = [
      runExportUrl('C:/work/app', 'run-1', 'md', 'en'),
      runExportUrl('C:/work/app', 'run-1', 'csv', 'en'),
      runExportUrl('C:/work/app', 'run-1', 'pdf', 'en'),
      releaseExportUrl('C:/work/app', '1.4', 'md', 'en'),
      releaseExportUrl('C:/work/app', '1.4', 'html', 'en'),
      releaseExportUrl('C:/work/app', '1.4', 'pdf', 'en'),
    ];
    for (const url of urls)
      expect(new URL(url, 'http://x').searchParams.get('lang'), url).toBe('en');
    expect(releaseExportUrl('C:/work/app', '1.4', 'md')).not.toContain('lang=');
  });
});
