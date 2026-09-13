import type {
  Platform,
  PlatformHealthRecord,
  PlatformModelInfo,
  PlatformModelRules,
  PlatformModelSource,
  PlatformToolRoute,
} from '@agentdeck/contracts';
import { catalogChatModels, catalogDefaultModel } from '@agentdeck/contracts/platform-models';
import type { AppStore } from '../../lib/app-store.ts';
import { managedModel } from './apply/profile.ts';
import { driverOf } from './drivers/index.ts';
import { chooseToolRoute } from './gateway/dialect.ts';

/**
 * Модель контура: что панель кладёт в управляемый профиль, в окружение прогона
 * и в `--model` (Т6).
 *
 * Здесь только ПРАВИЛА выбора — сам выбор считает общая функция контрактов
 * (`chooseRunModel`), потому что тот же расчёт делает шапка чата. Разделение не
 * ради красоты: правила читают состояние панели (настройка контура, каталог
 * последней пробы), а расчёт обязан быть один на оба берега.
 */

/**
 * Модели каталога последней пробы, которыми можно вести разговор. Отбор —
 * общий с карточкой контура (`catalogChatModels` в контрактах): две копии
 * грамматики видов разошлись бы, и человек выбирал бы в панели модель, которой
 * прогон пойти не может.
 */
export function chatModels(health: PlatformHealthRecord | undefined): PlatformModelInfo[] {
  return catalogChatModels(health?.models ?? []);
}

/**
 * Модель контура по умолчанию и ОТКУДА она взялась.
 *
 * Выбор человека сильнее каталога всегда — в том числе когда контур эту модель
 * временно не отдаёт: пропавшая из ответа модель чаще означает суженные права
 * ключа, чем осознанное решение, и молча подменить её первой попавшейся значило
 * бы увести разговор на другую модель без единого слова.
 *
 * Первая чатовая модель каталога — не «панель выбрала за человека», а ответ на
 * обещание «у управляемого профиля ВСЕГДА есть модель»: профиль без неё
 * отправляет CLI в контур с моделью по умолчанию САМОГО CLI, то есть с именем
 * вендора, которого контур не знает, и 403 «модель» человек читает как поломку
 * панели. Поэтому подстановка названа источником (`catalog`) и показывается
 * везде, где показывается сама модель.
 */
export function defaultModelOf(
  store: AppStore,
  platform: Platform,
): { model: string; source: PlatformModelSource } {
  const chosen = managedModel(store, platform.id);
  if (chosen) return { model: chosen, source: 'default' };
  const first = catalogDefaultModel(store.getPlatformHealth()[platform.id]?.models ?? []);
  return first ? { model: first.id, source: 'catalog' } : { model: '', source: 'none' };
}

/**
 * Правила выбора модели для ОДНОГО потребителя: его переопределение поверх
 * модели контура, плюс карта соответствия и каталог, по которым считается имя,
 * названное самим прогоном.
 */
export function modelRulesFor(
  store: AppStore,
  platform: Platform,
  consumer: string,
): PlatformModelRules {
  const health = store.getPlatformHealth()[platform.id];
  const own = platform.consumerModels[consumer]?.trim() ?? '';
  const fallback = defaultModelOf(store, platform);
  return {
    model: own || fallback.model,
    source: own ? 'consumer' : fallback.source,
    map: platform.modelMap,
    catalog: chatModels(health).map((model) => model.id),
  };
}

/**
 * Контур принимает усилие рассуждения. Отвечает МАНИФЕСТ драйвера, а не проба:
 * усилие — это поле запроса, и узнать о нём можно только из документации
 * платформы (у enterprise-platform `reasoning_effort` в публичной схеме не встретился ни
 * разу — Т12 просит его добавить).
 */
export function effortAccepted(platform: Platform): boolean {
  return driverOf(platform).effort;
}

/**
 * Чем инструменты клиента дойдут до модели — тем же решением, что принимает
 * конвейер (`chooseToolRoute`), а не пересказом: подпись «работает как чат» у
 * цели, стоявшая у каждого типа контура, врала совместимому шлюзу (аудит DRV-13).
 */
export function toolRouteOf(platform: Platform): PlatformToolRoute {
  const route = chooseToolRoute(
    {
      toolShim: platform.toolShim,
      platformTools: platform.rules.platform.platformTools.length > 0,
    },
    driverOf(platform),
    () => '',
  );
  return route?.mode ?? 'none';
}
