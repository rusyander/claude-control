import type { AskFields } from '@agentdeck/contracts/core/ask';
import { chatConsumerOf } from '@agentdeck/contracts/platform-consumers';
import { chooseRunModel } from '@agentdeck/contracts/platform-models';
import type { AppStore } from '../../../lib/app-store/app-store.ts';
import { modelRulesFor } from '../models/models.ts';
import { consumersOf } from '../store/store.ts';
import { activePlatform } from './routing.ts';

/**
 * Маршрут контура для задачи ядра по галочке потребителя (этап 10, F6): прогон, который прежде
 * шёл процессом панели с окружением контура (`resolveRunRoute`), теперь задача ядра, и контур —
 * её разрешённый набор: маршрут `gateway:<id>` реестра ядра. Шлюз, ключ и обязательный контур
 * судит ядро (`set-route`); панель лишь переводит выбор человека — активный контур и галочку
 * потребителя — в этот набор.
 *
 * Модель — выбор человека для потребителя (своя модель потребителя, иначе модель контура):
 * точный шаблон даёт суду уровня модель маршрута. Модели нет — шаблон `*`, и маршрут с адресом
 * без модели ядро отказывает по имени, а не угадывает.
 *
 * Обязательный контур (решение 02.11) ведёт через себя КАЖДОГО потребителя, галочка отмечена или
 * нет: ядро и так сводит любой набор к шлюзу (L1, `contourNarrow`), а без маршрута отсюда шаблон
 * модели оставался `*` — снятая галочка не решала ничего и роняла прогон отказом «needs a
 * concrete model». Галочки решают только при режиме «по возможности».
 */

export type CoreContourRoutes = NonNullable<AskFields['routes']>;

/** Маршрут контура в реестре ядра: `gateway:<id>` (`routes/gateway/gateway.ts` ядра). */
export const coreGatewayRouteId = (platformId: string): string => `gateway:${platformId}`;

/**
 * `asked` — модель, выбранная в чате (или назначенная ступени). Через контур она просьба, а не
 * решение (s10 G7): тот же перевод, что подпись шапки чата (`platformModelCaption`) и прежний
 * маршрут панели (`resolveRunRoute`), — карта соответствия, каталог контура, иначе модель контура.
 * Имя вендора, которого контур не знает, в шаблон не попадает: ядро отказало бы `set-model`
 * под чужим шаблоном, а мимо шаблона контур ответил бы 403.
 */
export function coreContourRoutes(
  store: AppStore,
  consumer: string,
  adapter: string,
  asked = '',
): CoreContourRoutes | undefined {
  const platform = activePlatform(store);
  if (!platform) return undefined;
  if (platform.mode !== 'required' && !consumersOf(platform).includes(consumer)) return undefined;
  const model = chooseRunModel(modelRulesFor(store, platform, consumer), asked).model.trim();
  return [
    {
      adapter,
      route: { kind: 'gateway', id: coreGatewayRouteId(platform.id) },
      modelPattern: model || '*',
    },
  ];
}

// Правило потребителя чата — в контрактах: по нему же шапка веба называет маршрут хода.
export { chatConsumerOf };

/** Маршрут контура хода единого чата: потребитель — по CLI разговора (`chatConsumerOf`). */
export function chatContourRoutes(
  store: AppStore,
  cli: string,
  asked = '',
): CoreContourRoutes | undefined {
  return coreContourRoutes(store, chatConsumerOf(cli), cli, asked);
}

/**
 * Модель задачи, которую ведёт контур: точный шаблон маршрута `gateway:<id>`. Её и шлёт `set-model`
 * вместо выбора человека — переведённого уже в `coreContourRoutes`; усилие через контур не
 * уезжает (подпись шапки обещает то же). Шаблон `*` или маршрута контура нет — `undefined`.
 */
export function contourModelOf(routes: CoreContourRoutes | undefined): string | undefined {
  const gateway = routes?.find((item) => item.route.kind === 'gateway');
  const pattern = gateway?.modelPattern ?? '';
  return pattern && !pattern.includes('*') ? pattern : undefined;
}
