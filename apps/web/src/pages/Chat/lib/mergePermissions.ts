import type { ChildPermission } from '@features/ChatMessages';

/** То же для прав: запрос, который вкладка уже показывает, второй раз не рисуем. */
export function mergePermissions(
  live: ChildPermission[],
  server: ChildPermission[],
): ChildPermission[] {
  const seen = new Set(live.flatMap((child) => child.permissions.map((p) => p.toolUseId)));
  const out = [...live];
  for (const child of server) {
    const fresh = child.permissions.filter((p) => !seen.has(p.toolUseId));
    if (fresh.length > 0) out.push({ ...child, permissions: fresh });
  }
  return out;
}
