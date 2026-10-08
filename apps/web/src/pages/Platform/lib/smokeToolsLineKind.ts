import type { Platform, PlatformSmokeTools } from '@agentdeck/contracts';

/**
 * Наклонение строки пробы инструментов (развилка 3).
 *
 * `ok` — модель зовёт полем; `offer` — не зовёт, и прослойку предлагают кнопкой;
 * `auto` — прослойку по этому же итогу уже включила ПАНЕЛЬ, и строка отчитывается
 * о сделанном с кнопкой обратно; `none` — говорить не о чем.
 *
 * `auto` отдельно от `none` ровно потому, что прослойка включена: умолчание,
 * молчащее о себе, человек узнаёт по счёту за длинный ход, а не по карточке.
 */
export type SmokeToolsLineKind = 'ok' | 'offer' | 'auto' | 'none';

export function smokeToolsLineKind(
  platform: Pick<Platform, 'toolShim' | 'toolShimFromProbe'>,
  tools: PlatformSmokeTools,
): SmokeToolsLineKind {
  if (platform.toolShim) {
    // Прослойку включил человек — итог пробы остался от запуска БЕЗ неё и про
    // нынешний путь не говорит ничего.
    return platform.toolShimFromProbe && !tools.ok ? 'auto' : 'none';
  }
  return tools.ok ? 'ok' : 'offer';
}
