import { useState } from 'react';
import type {
  Platform,
  PlatformApplyResult,
  PlatformProbeResult,
  PlatformStatus,
} from '@agentdeck/contracts';
import {
  newPlatform,
  isPlatformValid,
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
  onDone: () => void;
}

export function usePlatformWizard({ existing, onDone }: PlatformWizardOptions) {
  const [step, setStep] = useState<WizardStep>('address');
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
  const apply = useApplyPlatform();
  const gateway = usePlatformGateway();
  const restartGateway = useRestartGateway();
  const updateSettings = useUpdateSettings();
  const plan = usePlatformApplyPlan(draft.id, { enabled: stored && step === 'targets' });

  const patch = (fields: Partial<Platform>): void => {
    setDraft((current) => draftWithPatch(current, fields, idTouched));
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

  const toggleOverwrite = (targetId: string): void => {
    setOverwrite((current) => toggled(current, targetId));
  };

  /**
   * Готово: включить контур, запомнить выбор целей и записать их. Порядок
   * важен — применение спрашивает у сервера уже сохранённый контур, и
   * включение обязано лечь раньше, иначе план вернул бы «шлюз не поднят».
   */
  const finish = async (): Promise<void> => {
    await save.mutateAsync(savePayload({ ...draft, enabled: true, targets }, token));
    setStored(true);
    const result = await apply.mutateAsync({ id: draft.id, targets, overwrite });
    setApplied(result);
    // Занятое место мастер не перебивает молча: пропущенные цели остаются на
    // экране с причиной, и человек решает — перезаписать или оставить как есть.
    if (result.skipped.length === 0) onDone();
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
    targets,
    toggleTarget,
    overwrite,
    toggleOverwrite,
    probe,
    applied,
    plan,
    gateway: gateway.data,
    isBusy:
      save.isPending ||
      check.isPending ||
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
