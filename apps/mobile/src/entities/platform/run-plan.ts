import { ourLayerIds } from '@agentdeck/contracts/platform-layers';
import type { PlatformRunPlan } from '@agentdeck/contracts';
import { chooseRunModel, modelCaptionState } from '@agentdeck/contracts/platform-models';
import type { Dictionary } from '../../shared/config/i18n/ru';

/**
 * Что сказать под полем ввода о прогоне через контур (Т6/Т8) — те же подписи,
 * что у шапки чата в панели (`ChatModelPicker`).
 *
 * Модель считается ТОЙ ЖЕ функцией `chooseRunModel`, что сервер и обе шапки
 * панели: третий расчёт на телефоне разошёлся бы с ними молча, и человек видел
 * бы одно имя, а в контур уезжало бы другое. Снятые слои и отказ считает сервер,
 * здесь только выбор слов. Чистой функцией, а не внутри экрана: тесты телефона
 * гоняют логику, а не нативное.
 */

type Words = Dictionary['composer'];

export interface RunPlanLine {
  text: string;
  /** Уедет не то, что выбрано, или сообщение отклонят — стоит присмотреться. */
  warn: boolean;
}

export interface RunPlanView {
  /**
   * Выбор модели и глубины ЗАПЕРТ: модель решает контур. Пусто — выбор свободен.
   * Сохранённый выбор чата не стирается — выключенный контур вернёт его как был.
   */
  locked?: { model: string; effort: string; hint: string };
  lines: RunPlanLine[];
}

/**
 * Потребителем какого маршрута спрашивать план ЭТОГО разговора.
 *
 * Сервер маршрутизирует любой чат со связью разделения как «Группы»
 * (`routes/chat/run-routes.ts`), а телефон показывает все чаты подряд, детей
 * разделения включительно. Ревью Т13: здесь стояло жёстко `'chat'`, и у
 * контура, включённого только для «Чата», открытый на телефоне ребёнок запирал
 * модель и писал «через контур …» про прогон, уходивший в облако вендора со
 * всеми нашими слоями; у контура для одних «Групп» — молчал и предлагал
 * свободный выбор модели прогону, которому контур модель всё равно подменит.
 *
 * Список ещё не приехал — отвечаем «Чат»: это тот же ответ, что у разговора без
 * связи, и подписи появятся сами, когда список догрузится.
 */
export function runPlanConsumer(
  chats: readonly { id: string; parentId?: string }[] | undefined,
  chatId: string,
): 'chat' | 'groups' {
  const chat = chats?.find((item) => item.id === chatId);
  return chat?.parentId ? 'groups' : 'chat';
}

export function runPlanView(
  plan: PlatformRunPlan | undefined,
  chosen: { model: string; effort: string },
  words: Words,
): RunPlanView {
  const lines: RunPlanLine[] = [];
  const routed = plan?.routed === true ? plan : undefined;
  const choice = routed ? chooseRunModel(routed.rules, chosen.model) : undefined;

  if (routed && choice) {
    // Состояние выбирают КОНТРАКТЫ — той же функцией, что и панель: второй
    // разбор «у контура без модели заменять нечем» разошёлся бы с ней молча, и
    // состояние, добавленное в панели, телефон бы не узнал (ревью Т13).
    switch (modelCaptionState(choice)) {
      case 'unset':
        lines.push({ text: words.platformModelUnset(routed.title), warn: true });
        break;
      case 'replaced':
        lines.push({
          text: words.platformModelReplaced(routed.title, choice.asked, choice.model),
          warn: true,
        });
        break;
      default:
        lines.push({ text: words.platformModel(routed.title, choice.model), warn: false });
    }
  }

  if (plan?.refused) {
    const reason = plan.reason === 'no_token' ? 'no_token' : 'gateway_down';
    lines.push({
      text: words.platformRefused(
        plan.title,
        words.platformRefusedReason[reason],
        words.platformRefusedFix[reason],
      ),
      warn: true,
    });
  }

  if (plan?.bypassed) {
    // Решение по контуру №4: «по возможности» живёт, только пока каждый уход мимо
    // контура назван прямо — тем же, что шапка чата в панели.
    const reason = plan.reason === 'no_token' ? 'no_token' : 'gateway_down';
    lines.push({
      text: words.platformBypassed(
        plan.title,
        words.platformRefusedReason[reason],
        words.platformRefusedFix[reason],
      ),
      warn: true,
    });
  }

  const dropped = routed?.layers?.dropped ?? [];
  if (routed && dropped.length > 0) {
    // Полный набор — отдельной фразой; число слоёв берётся из КОНТРАКТА, как в
    // панели (`platformLayersCaption`). По словарю названий это было правдой
    // только пока словарь полон: пропущенный ключ (ровно так на телефоне
    // потерялась причина `gateway-failed` в волне D) молча делал бы «снято
    // всё» из неполного набора.
    const all = dropped.length === ourLayerIds.length;
    lines.push({
      text: all
        ? words.platformLayersAll(routed.title)
        : // Разделитель — точка: в названии слоя уже есть запятые.
          words.platformLayers(routed.title, dropped.map((id) => words.layerTitle[id]).join(' · ')),
      warn: false,
    });
  }

  if (routed && !routed.effort) {
    lines.push({ text: words.platformNoEffort(routed.title), warn: false });
  }

  if (!routed || !choice) return { lines };
  return {
    locked: {
      model: choice.model || words.platformModelNone,
      effort: routed.effort ? chosen.effort || words.modelDefault : words.platformEffortOff,
      hint: words.platformLocked(routed.title),
    },
    lines,
  };
}
