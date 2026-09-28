import { useQuery } from '@tanstack/react-query';
import type { ShotVariantIndex } from './shotVariant.types';

/**
 * Опись вариантов кадров раздела — один запрос на раздел, общий для всех его
 * `<HelpShot>`. Это статика рядом с картинками, а не API: меняется только
 * пересъёмкой, поэтому не устаревает за время жизни страницы.
 *
 * Ошибка (описи нет) — не авария: `pickShot` тогда показывает исходный кадр.
 * `settled` отличает «ещё грузится» от «грузить нечего», чтобы картинка не
 * мелькнула исходным вариантом перед нужным.
 */
export function useShotVariants(topic: string): {
  index: ShotVariantIndex | undefined;
  settled: boolean;
} {
  const query = useQuery({
    queryKey: ['help', 'shot-variants', topic],
    queryFn: async (): Promise<ShotVariantIndex> => {
      const response = await fetch(`/help/${topic}/variants.json`);
      if (!response.ok) throw new Error(`variants.json: ${response.status}`);
      return (await response.json()) as ShotVariantIndex;
    },
    staleTime: Infinity,
    gcTime: Infinity,
    retry: false,
    refetchOnWindowFocus: false,
  });
  return { index: query.data, settled: !query.isPending };
}
