import type { ProjectTestGroup } from '@agentdeck/contracts';

/**
 * Счёт и проверки окна «Настройки набора».
 *
 * Всё здесь чистое и считается по тому же виду, который уже приехал на экран:
 * лишний запрос ради «в скольких кейсах используется общий шаг» означал бы
 * второй источник правды о файлах, которые панель и так держит целиком.
 */

/**
 * Сколько кейсов ссылается на каждый общий шаг.
 *
 * Ссылка — это `ref` шага кейса; `action` при ней держит подпись для чтения,
 * поэтому считать по названиям нельзя. Архивные кейсы считаются наравне:
 * шаг, оставшийся только в архиве, всё равно сломает архивный кейс, если его
 * удалить, — а удалять шаг никто не мешает, просто теперь видно, что чинить.
 */
export function sharedStepUsage(groups: ProjectTestGroup[]): Map<string, number> {
  const usage = new Map<string, number>();
  for (const group of groups) {
    if (group.error) continue;
    for (const testCase of group.cases) {
      const refs = new Set(
        testCase.steps.map((step) => step.ref).filter((ref): ref is string => Boolean(ref)),
      );
      for (const ref of refs) usage.set(ref, (usage.get(ref) ?? 0) + 1);
    }
  }
  return usage;
}
