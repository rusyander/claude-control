import { clientToolsTravel, type PlatformClientTools } from '@agentdeck/contracts/platform-presets';

/**
 * Как инструменты клиента едут наверх на этом запросе. Решает конвейер —
 * тумблером прослойки и манифестом драйвера; нет маршрута — инструменты
 * теряются и названы потерей.
 */
export type ToolRoute =
  /** Текстом протокола (Т5). */
  | {
      mode: 'shim';
      /** Текст протокола из каталога промптов (Т4). Здесь его копии нет и не будет. */
      protocolText: string;
      /** Чем гасятся инструменты самой платформы (`driver.shimRequestFields`). */
      requestFields?: Readonly<Record<string, unknown>>;
    }
  /**
   * Полем `tools` диалекта OpenAI: платформа его принимает — `clientTools`
   * `native` или `native-no-call`. Зовёт ли по нему модель, маршрут не решает:
   * это вопрос модели, и отвечает на него проба при активации.
   */
  | { mode: 'native' };

/**
 * Маршрут инструментов — одно решение на конвейер и на проверку драйверов.
 *
 * Порядок — от сильного к слабому:
 * - инструменты САМОЙ платформы (Т7) — два набора на один ход взаимно
 *   исключаются, и клиентские теряются, названные потерей;
 * - тумблер прослойки — выбор человека: шлюз без разборщика вызовов у модели
 *   принимает `tools` схемой и молча не зовёт ничего, и лечится это только им;
 * - манифест драйвера: платформа, принимающая `tools` полем, получает их полем.
 *
 * `native-no-call` идёт тем же маршрутом, что и `native`: поле платформа
 * принимает, и выбрасывать его здесь значило бы объявить потерей то, что
 * доезжает. Своё оно говорит умолчанием прослойки и словами на карточке, а не
 * подменой маршрута — иначе модель, начавшая звать (сменили её или шлюз
 * дообучили), не смогла бы это показать никогда.
 *
 * Текст протокола читается только там, где он нужен: это файл каталога.
 */
export function chooseToolRoute(
  platform: { toolShim: boolean; platformTools: boolean },
  driver: {
    clientTools: PlatformClientTools;
    shimRequestFields?: Readonly<Record<string, unknown>>;
  },
  protocolText: () => string,
): ToolRoute | undefined {
  if (platform.platformTools) return undefined;
  if (platform.toolShim) {
    return {
      mode: 'shim',
      protocolText: protocolText(),
      ...(driver.shimRequestFields ? { requestFields: driver.shimRequestFields } : {}),
    };
  }
  return clientToolsTravel(driver.clientTools) ? { mode: 'native' } : undefined;
}
