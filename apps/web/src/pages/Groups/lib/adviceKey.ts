export function adviceKey(item: { kind: string; id: string }): string {
  return `${item.kind}:${item.id}`;
}
