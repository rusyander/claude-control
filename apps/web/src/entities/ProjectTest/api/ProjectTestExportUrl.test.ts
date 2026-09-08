import { describe, expect, it } from 'vitest';
import { runExportUrl } from './ProjectTestExchangeApi';
import { releaseExportUrl } from './ProjectTestReleaseApi';

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
});
