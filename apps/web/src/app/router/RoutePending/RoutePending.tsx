import { SkeletonList } from '@shared/ui/skeleton';

/** Чанк раздела едет дольше секунды — скелет вместо застывшей предыдущей страницы. */
export function RoutePending() {
  return <SkeletonList rows={4} withActions={false} />;
}
