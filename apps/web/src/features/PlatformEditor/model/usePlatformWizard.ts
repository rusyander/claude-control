import { useState } from 'react';
import {
  type Platform,
  type PlatformApplyResult,
  type PlatformProbeResult,
  type PlatformStatus,
} from '@agentdeck/contracts';
import {
  newPlatform,
  isPlatformValid,
  useActivatePlatform,
  useApplyPlatform,
  useCheckPlatform,
  usePlatformApplyPlan,
  usePlatformGateway,
  useRestartGateway,
  useSavePlatform,
} from '@entities/Platform';
import { useUpdateSettings } from '@entities/AppConfig';
import {
  confirmedCapabilities,
  draftWithPatch,
  finishCloses,
  finishPlan,
  initialTargets,
  needsGatewayEnable,
  savePayload,
  stepAfter,
  stepBefore,
  toggled,
  type WizardStep,
} from './wizard-logic';

/**
 * Мастер подключения контура: четыре шага и вся их последовательность.
 *
 * Здесь заперты два неочевидных свойства.
 *
 * ПЕРВОЕ: пробу делает СЕРВЕР, а сервер ходит к контуру по сохранённой
 * настройке и сохранённому ключу. Значит «Проверить связь» обязано сначала
 * сохранить черновик — иначе проверять было бы нечего. Контур при этом остаётся
 * выключённым до последнего шага: сохранённый черновик ничего не применяет и
 * никуда не ходит сам.
 *
 * ВТОРОЕ: список подтверждённых возможностей ведёт сервер (успешная проба его
 * переписывает). Поэтому после пробы черновик забирает его к себе — иначе
 * «Готово» отправило бы обратно тот пустой список, с которым мастер открылся, и
 * панель забыла бы то, что сама же выяснила минуту назад.
 */

export interface PlatformWizardOptions {
  /** Правка существующего контура: черновик и цели берутся из него. */
  existing?: PlatformStatus;
  /** С какого шага открыть: агент панели ведёт человека сразу к полю ключа. */
  initialStep?: WizardStep;
  /** Мастер завершён; `result` — что применение записало и что пропустило. */
  onDone: (result?: PlatformApplyResult) => void;
}

export function usePlatformWizard({ existing, initialStep, onDone }: PlatformWizardOptions) {
  const [step, setStep] = useState<WizardStep>(initialStep ?? 'address');
  const [draft, setDraft] = useState<Platform>(existing?.platform ?? newPlatform('', ''));
  /** Пусто — ключ не трогали: сохранённый останется на месте. */
  const [token, setToken] = useState('');
  const [idTouched, setIdTouched] = useState(Boolean(existing));
  const [targets, setTargets] = useState<string[]>(initialTargets(existing));
  const [overwrite, setOverwrite] = useState<string[]>([]);
  const [probe, setProbe] = useState<PlatformProbeResult | undefined>(existing?.health);
  const [applied, setApplied] = useState<PlatformApplyResult | undefined>();
  /** Настройка контура уже лежит на сервере: с этого момента можно и пробовать, и планировать. */
  const [stored, setStored] = useState(Boolean(existing));

  const save = useSavePlatform();
  const check = useCheckPlatform();
  const activate = useActivatePlatform();
  const apply = useApplyPlatform();
  const gateway = usePlatformGateway();
  const restartGateway = useRestartGateway();
  const updateSettings = useUpdateSettings();
  const plan = usePlatformApplyPlan(draft.id, { enabled: stored && step === 'targets' });

  const patch = (fields: Partial<Platform>): void => {
    setDraft((current) => draftWithPatch(current, fields, idTouched, !existing));
  };

  const setId = (id: string): void => {
    setIdTouched(true);
    setDraft((current) => ({ ...current, id }));
  };

  /** Сохранить черновик и сходить к контуру. Ключ уезжает только если его вводили. */
  const probeNow = async (): Promise<void> => {
    const payload = savePayload(draft, token);
    await save.mutateAsync(payload);
    setStored(true);
    const result = await check.mutateAsync(payload.platform.id);
    setProbe(result);
    if (result.outcome === 'ok') {
      const confirmed = confirmedCapabilities(result);
      setDraft((current) => ({ ...current, capabilities: confirmed }));
    }
  };

  /** Поднять шлюз по кнопке из последнего шага: без него применять к CLI нечего. */
  const startGateway = async (): Promise<void> => {
    const settings = gateway.data?.settings;
    if (settings && needsGatewayEnable(settings)) {
      await updateSettings.mutateAsync({ platformGateway: { ...settings, enabled: true } });
    }
    await restartGateway.mutateAsync();
  };

  const toggleTarget = (targetId: string): void => {
    setTargets((current) => toggled(current, targetId));
  };

  /**
   * Потребитель маршрута (Т3) живёт в самом черновике, а не отдельным списком:
   * он сохраняется вместе с контуром, и «Готово» отправляет его тем же
   * запросом. Порядок важен — сохранение идёт ДО применения, поэтому галочка
   * «Терминал», поставленная здесь, уже действует к моменту записи в файлы.
   */
  const toggleConsumer = (consumerId: string): void => {
    setDraft((current) => ({ ...current, consumers: toggled(current.consumers, consumerId) }));
  };

  const toggleOverwrite = (targetId: string): void => {
    setOverwrite((current) => toggled(current, targetId));
  };

  /**
   * Готово: сохранить, при ПОДКЛЮЧЕНИИ сделать активным и записать в выбранные
   * цели.
   *
   * Порядок важен и он же объясняет средний шаг. Включённый контур — это
   * активный контур и никакой другой (инвариант 1), поэтому сохранение тумблер
   * не трогает вовсе: «подключить» здесь значит «перевести работу на него», а
   * это транзакция — применения прежнего контура снимаются, его тумблер гаснет.
   * Активация же обязана лечь ДО применения: план спрашивает у сервера уже
   * сохранённый и уже включённый контур, иначе цели вернулись бы негодными.
   *
   * ПРАВКА активность НЕ переносит. Та же форма открывается кнопкой «Настройка
   * контура» на карточке любого контура, и «Готово» в ней означает «сохранить
   * то, что я поправил», а не «перевести на него всю машину»: об этом не
   * говорят ни подпись кнопки, ни заголовок, ни справка. Активным контур
   * делают его собственной кнопкой, где рядом написано, что при этом
   * случится.
   */
  const finish = async (): Promise<void> => {
    // Цели применения СОБИРАЮТСЯ из потребителей (Т3), а не спрашиваются
    // вторично; что сохраняется и что применяется — разные списки (`finishPlan`).
    const { platform, applyTargets } = finishPlan(draft, targets, plan.data?.consumers);
    await save.mutateAsync(savePayload(platform, token));
    setStored(true);
    if (!existing) await activate.mutateAsync(draft.id);
    const result = await apply.mutateAsync({ id: draft.id, targets: applyTargets, overwrite });
    setApplied(result);
    // Занятое место мастер не перебивает молча: пока пропуск чинится галочкой
    // «перезаписать» в этом окне, окно остаётся открытым. Остальные пропуски
    // (контур не активен, шлюз не поднят) отсюда не чинятся — мастер
    // закрывается и называет их вслух (D3).
    if (finishCloses(result)) onDone(result);
  };

  const next = (): void => setStep(stepAfter(step));
  const back = (): void => setStep(stepBefore(step));

  return {
    step,
    setStep,
    draft,
    patch,
    setId,
    token,
    setToken,
    // Маска сохранённого ключа (префикс и хвост) — только чтобы показать, что он
    // есть и останется: само значение наружу из панели не выходит.
    savedToken: existing?.hasToken ? existing.maskedToken : '',
    targets,
    toggleTarget,
    toggleConsumer,
    overwrite,
    toggleOverwrite,
    probe,
    applied,
    plan,
    gateway: gateway.data,
    isBusy:
      save.isPending ||
      check.isPending ||
      activate.isPending ||
      apply.isPending ||
      restartGateway.isPending ||
      updateSettings.isPending,
    isProbing: save.isPending || check.isPending,
    isValid: isPlatformValid(draft),
    probeNow,
    startGateway,
    finish,
    next,
    back,
  };
}

export type PlatformWizardModel = ReturnType<typeof usePlatformWizard>;
