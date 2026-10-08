import type { ModelBench, LocalDevice } from '@agentdeck/contracts/local-models';

/**
 * Где снят замер, если не там, где модель считает сейчас: замер видеокарты рядом
 * с оценкой для процессора без подписи читался бы как скорость процессора.
 * Совпадает — undefined, и строка пишет просто «Замерено».
 */
export function benchElsewhere(bench: ModelBench, device: LocalDevice): LocalDevice | undefined {
  const where = bench.device ?? (bench.gpu === 'cpu' ? 'cpu' : 'gpu');
  return where === device ? undefined : where;
}
