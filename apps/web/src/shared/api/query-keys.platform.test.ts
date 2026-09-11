import { describe, it, expect } from 'vitest';
import { queryKeys } from './query-keys';

/**
 * Ключи кеша контура.
 *
 * Проверяется ровно одно свойство, но неочевидное: план применения — ветка
 * КОНКРЕТНОГО контура, а шлюз и список — нет. Стоило бы плану лечь в общий
 * ключ, и предпросмотр одного контура рисовался бы ответом соседнего; стоило бы
 * шлюзу стать веткой контура, и его счётчики сбрасывались бы на каждую пробу.
 */
describe('ключи контура', () => {
  it('план применения зависит от контура, а шлюз и список — нет', () => {
    expect(queryKeys.platformApply('enterprise-platform-dev')).toEqual(['platforms', 'enterprise-platform-dev', 'apply']);
    expect(queryKeys.platformApply('enterprise-platform-prod')).not.toEqual(
      queryKeys.platformApply('enterprise-platform-dev'),
    );
    expect(queryKeys.platforms).toEqual(['platforms']);
    expect(queryKeys.platformGateway).toEqual(['platforms', 'gateway']);
  });

  it('реестр компромиссов живёт своим корнем, а не веткой контура', () => {
    // Список статический: сброс кеша после пробы контура не должен ронять то,
    // что к этой пробе отношения не имеет.
    expect(queryKeys.compromises[0]).not.toBe('platforms');
  });
});
