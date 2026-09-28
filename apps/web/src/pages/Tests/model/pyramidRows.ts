import type { ProjectTestPyramid, ProjectTestPyramidCount } from '@agentdeck/contracts';

/** Строка пирамиды: слой, его счёт (пусто — «не известно») и папка, если есть. */
export interface PyramidRow {
  layer: 'unit' | 'integration' | 'code' | 'e2e';
  count?: ProjectTestPyramidCount;
  dir?: string;
}

/**
 * Строки пирамиды сверху вниз — e2e, интеграционные, модульные, как её рисуют.
 *
 * Без меток проекта модульные с интеграционными — одна строка «тесты кода»:
 * две строки с выдуманным делением были бы хуже одной честной. Без каркаса —
 * строка всё равно есть, со словом «не известно»: её отсутствие читалось бы
 * как «модульных тестов нет».
 */
export function pyramidRows(data: ProjectTestPyramid): PyramidRow[] {
  const e2e: PyramidRow = data.e2e
    ? { layer: 'e2e', count: data.e2e, dir: data.e2e.dir }
    : { layer: 'e2e' };
  if (data.split) {
    return [
      e2e,
      { layer: 'integration', count: data.integration },
      { layer: 'unit', count: data.unit },
    ];
  }
  return [e2e, { layer: 'code', count: data.code }];
}
