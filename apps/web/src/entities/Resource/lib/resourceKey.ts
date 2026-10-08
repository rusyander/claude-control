import type { ResourceKind } from '../api/ResourceApi.types';

export function resourceKey(kind: ResourceKind, id: string) {
  return ['resources', kind, id] as const;
}
