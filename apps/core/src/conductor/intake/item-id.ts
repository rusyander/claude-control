import { createHash } from 'node:crypto';

/**
 * `cmdId` пункта `i`: первый — сам `cmdId` оценки (повтор находит задачу 0), прочие — тот же
 * UUIDv7 с узлом из отпечатка `cmdId#i`: время и версия те же, повтор выводит тот же id. Отдельный
 * модуль без зависимостей: его берёт и группа (`group.ts`), и дети XL (`split/children.ts`) —
 * через `group.ts` дети замкнули бы круг `split → intake → classify → split`.
 */
export function itemCmdId(cmdId: string, index: number): string {
  if (index === 0) return cmdId;
  const node = createHash('sha256').update(`${cmdId}#${index}`).digest('hex').slice(0, 12);
  return `${cmdId.slice(0, 24)}${node}`;
}
