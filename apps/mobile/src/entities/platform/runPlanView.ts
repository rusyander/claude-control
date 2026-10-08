import type { Dictionary } from '../../shared/config/i18n/ru';
import type { RunPlanLine } from './run-plan.types';
import type { PlatformRunPlan } from '@agentdeck/contracts';
import { chooseRunModel, modelCaptionState } from '@agentdeck/contracts/platform-models';
import { ourLayerIds } from '@agentdeck/contracts/platform-layers';

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

export type Words = Dictionary['composer'];

export interface RunPlanView {
  /**
   * Выбор модели и глубины ЗАПЕРТ: модель решает контур. Пусто — выбор свободен.
   * Сохранённый выбор чата не стирается — выключенный контур вернёт его как был.
   */
  locked?: { model: string; effort: string; hint: string };
  lines: RunPlanLine[];
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

  // Claude уведён на локальную модель: ответит она — шапка называет её, а не «Opus».
  const local = routed ? undefined : plan?.local;
  if (local) {
    lines.push({ text: words.localCaption(local.title), warn: false });
    return {
      locked: {
        model: local.title,
        effort: chosen.effort || words.modelDefault,
        hint: words.localLocked(local.title),
      },
      lines,
    };
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
