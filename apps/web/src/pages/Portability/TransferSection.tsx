import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { TransferFilePlan, TransferPlan } from '@agentdeck/contracts/portable-transfer';
import { Card } from '@shared/ui/card';
import { Stack } from '@shared/ui/stack';
import { Badge } from '@shared/ui/badge';
import { Button } from '@shared/ui/button';
import { Modal } from '@shared/ui/modal';
import { Typography } from '@shared/ui/typography';
import { toErrorMessage } from '@shared/api/client';
import { DIFF_LINE_PREFIX } from '@shared/config/diff-line-prefix';
import { formatDateTime } from '@shared/lib/format';
import { toast } from '@shared/lib/toast';
import {
  OUTCOME_ORDER,
  OUTCOME_TONE,
  outcomeLabelKey,
  summarizeOutcomes,
  summarizePlan,
  usePlanTransfer,
  useApplyTransfer,
  useRevertTransfer,
  useTransferState,
  type PortabilityLevel,
} from '@entities/Portability';
import styles from './PortabilityPage.module.scss';

interface TransferSectionProps {
  source: string;
  target: string;
  targetName: string;
  /** Уровень записи: дом или проект. Едет в каждый из трёх шагов переноса. */
  level: PortabilityLevel;
}

/**
 * Перенос среды: показать, применить, отменить (П2.3).
 *
 * ЧЕТЫРЕ ПРАВИЛА, ради которых раздел устроен именно так:
 *
 *  1. **Кнопки «перенести» без показанного плана не существует.** Не «она
 *     неактивна», а её нет: сервер и так ответит 409 без отпечатка, но человек
 *     не должен узнавать о порядке из отказа. Сначала — что именно изменится в
 *     файлах, и только потом решение.
 *  2. **Отмена живёт рядом с переносом всегда**, пока след есть на сервере, — и
 *     переживает перезагрузку страницы. Кнопка, исчезающая после F5, означала бы
 *     неизвестную цену ошибки, а её и боятся сильнее самой ошибки.
 *  3. **Файлы, которые человек правил ПОСЛЕ переноса, названы до нажатия** и по
 *     умолчанию не трогаются. Вернуть копию поверх его собственной правки — это
 *     стереть её молча, и такое делается только по его прямому слову.
 *  4. **Файлы разошлись с показом — это не ошибка, а новый план.** Сервер
 *     отвечает 409 и свежим планом; раздел ставит его на место прежнего, и
 *     человек видит, что изменилось, вместо загадочного отказа.
 */
export function TransferSection({ source, target, targetName, level }: TransferSectionProps) {
  const { t, i18n } = useTranslation();

  const state = useTransferState(source, target, level);
  const planning = usePlanTransfer();
  const applying = useApplyTransfer();
  const reverting = useRevertTransfer();

  /**
   * Показанный план. Живёт в состоянии раздела намеренно: он не ресурс, а
   * ответ на нажатие, и тянуть его фоном значило бы гонять настоящие операции
   * адаптеров при каждом открытии страницы.
   */
  const [plan, setPlan] = useState<TransferPlan | null>(null);
  const [openDiff, setOpenDiff] = useState<TransferFilePlan | null>(null);
  const [confirmApply, setConfirmApply] = useState(false);
  const [confirmRevert, setConfirmRevert] = useState(false);
  /** Файлы, изменённые после переноса, которые человек ВСЁ ЖЕ велел вернуть. */
  const [alsoRevert, setAlsoRevert] = useState<readonly string[]>([]);

  const record = state.data?.record ?? null;
  const changedSince = state.data?.changedSince ?? [];

  const summary = useMemo(() => (plan ? summarizePlan(plan) : null), [plan]);
  const outcomes = useMemo(() => (plan ? summarizeOutcomes(plan.entries) : null), [plan]);

  // Смена цели обнуляет показанный план: он посчитан для другой пары, и
  // «перенести» по нему записало бы не туда, куда смотрит человек.
  // Уровень входит в ключ наравне с парой: показанный план дома нельзя
  // применить к проекту — это другие файлы и другой отпечаток.
  const shownKey = `${source}->${target}:${level.scope}@${level.project ?? ''}`;
  const [shownFor, setShownFor] = useState(shownKey);
  if (shownFor !== shownKey) {
    setShownFor(shownKey);
    setPlan(null);
    setAlsoRevert([]);
  }

  const showPlan = () => {
    planning.mutate(
      { provider: source, target, ...level },
      {
        onSuccess: setPlan,
        onError: (error) => toast.error(toErrorMessage(error)),
      },
    );
  };

  const apply = () => {
    if (!plan) return;
    applying.mutate(
      { provider: source, target, ...level, fingerprint: plan.fingerprint },
      {
        onSuccess: (answer) => {
          setConfirmApply(false);
          setPlan(null);
          toast.success(
            t('portability.transfer.appliedToast', { count: answer.record.files.length }),
          );
        },
        onError: (error) => {
          setConfirmApply(false);
          // Файлы разошлись с показанным: свежий план приезжает тем же ответом —
          // ставим его на место прежнего, чтобы человек увидел РАЗНИЦУ, а не
          // только отказ.
          const fresh = freshPlanOf(error);
          if (fresh) setPlan(fresh);
          toast.error(toErrorMessage(error));
        },
      },
    );
  };

  const revert = () => {
    reverting.mutate(
      { provider: source, target, ...level, confirm: alsoRevert },
      {
        onSuccess: (answer) => {
          setConfirmRevert(false);
          setAlsoRevert([]);
          toast.success(t('portability.transfer.revertedToast', { count: answer.restored.length }));
        },
        onError: (error) => {
          setConfirmRevert(false);
          toast.error(toErrorMessage(error));
        },
      },
    );
  };

  return (
    <Card padding="md">
      <Stack gap="var(--spacing-sm)">
        <Typography variant="heading-sm">
          {t('portability.transfer.title', { target: targetName })}
        </Typography>

        {/* След переноса — над планом: человек, вернувшийся к экрану, первым
            делом спрашивает «что я уже сделал и как это отменить». */}
        {record && (
          <Stack gap="var(--spacing-2xs)" className={styles.applied}>
            <Typography variant="body-sm">
              {t('portability.transfer.applied', {
                count: record.files.length,
                date: formatDateTime(record.appliedAt, i18n.language),
              })}
            </Typography>

            {changedSince.length > 0 && (
              <Stack gap="var(--spacing-3xs)">
                <Typography variant="body-sm" color="warning">
                  {t('portability.transfer.changedSince', { count: changedSince.length })}
                </Typography>
                {changedSince.map((path) => (
                  <Typography key={path} variant="caption" className={styles.source}>
                    {path}
                  </Typography>
                ))}
              </Stack>
            )}

            <Stack direction="row" gap="var(--spacing-xs)">
              <Button
                variant="danger"
                onClick={() => {
                  setAlsoRevert([]);
                  setConfirmRevert(true);
                }}
              >
                {t('portability.transfer.revert')}
              </Button>
            </Stack>
          </Stack>
        )}

        {!plan && (
          <Stack gap="var(--spacing-2xs)">
            <Typography variant="body-sm" color="subtle">
              {t('portability.transfer.intro')}
            </Typography>
            <Stack direction="row" gap="var(--spacing-xs)">
              <Button variant="primary" isLoading={planning.isPending} onClick={showPlan}>
                {t('portability.transfer.plan')}
              </Button>
            </Stack>
          </Stack>
        )}

        {plan && summary && outcomes && (
          <Stack gap="var(--spacing-sm)">
            <Stack direction="row" gap="var(--spacing-3xs)" className={styles.summary}>
              <Badge tone="accent">
                {t('portability.transfer.files', { count: summary.files })}
              </Badge>
              <Badge tone="neutral">
                {t('portability.transfer.created', { count: summary.created })}
              </Badge>
              <Badge tone="neutral">
                {t('portability.transfer.lines', {
                  added: summary.added,
                  removed: summary.removed,
                })}
              </Badge>
              {/* Ноль показывается наравне с числом: отсутствие метки человек
                  читает как «такого здесь не бывает». */}
              {OUTCOME_ORDER.map((outcome) => (
                <Badge
                  key={outcome}
                  tone={outcomes[outcome] === 0 ? 'neutral' : OUTCOME_TONE[outcome]}
                >
                  {`${t(outcomeLabelKey(outcome))}: ${outcomes[outcome]}`}
                </Badge>
              ))}
            </Stack>

            {summary.runtimeOnly > 0 && (
              <Typography variant="body-sm" color="warning">
                {t('portability.transfer.runtimeNote', { count: summary.runtimeOnly })}
              </Typography>
            )}

            {/* Пустой план — ответ, а не ошибка: у цели уже лежит всё, что
                панель умеет перенести. */}
            {plan.files.length === 0 ? (
              <Typography variant="body-sm" color="subtle">
                {t('portability.transfer.emptyPlan')}
              </Typography>
            ) : (
              <Stack gap="var(--spacing-3xs)" className={styles.rows}>
                {plan.files.map((file) => (
                  <div key={file.filePath} className={styles.fileRow}>
                    <Stack gap="var(--spacing-3xs)" className={styles.intent}>
                      <Typography variant="caption" className={styles.source}>
                        {file.filePath}
                      </Typography>
                      <Stack direction="row" gap="var(--spacing-3xs)" className={styles.summary}>
                        {!file.exists && (
                          <Badge tone="info">{t('portability.transfer.willCreate')}</Badge>
                        )}
                        {file.unchanged && (
                          <Badge tone="neutral">{t('portability.transfer.unchangedFile')}</Badge>
                        )}
                        {!file.unchanged && (
                          <Badge tone="neutral">
                            {t('portability.transfer.lines', {
                              added: file.added,
                              removed: file.removed,
                            })}
                          </Badge>
                        )}
                      </Stack>
                    </Stack>
                    <Button variant="ghost" size="sm" onClick={() => setOpenDiff(file)}>
                      {t('portability.transfer.showDiff')}
                    </Button>
                  </div>
                ))}
              </Stack>
            )}

            <Stack direction="row" gap="var(--spacing-xs)">
              <Button
                variant="primary"
                isLoading={applying.isPending}
                onClick={() => setConfirmApply(true)}
              >
                {t('portability.transfer.apply')}
              </Button>
              <Button variant="secondary" isLoading={planning.isPending} onClick={showPlan}>
                {t('portability.transfer.replan')}
              </Button>
            </Stack>
          </Stack>
        )}
      </Stack>

      {/* Дифф файла — тем же языком, что лента изменений и предпросмотр одной
          записи: одна сущность показывается в панели одинаково везде. */}
      <Modal
        isOpen={openDiff !== null}
        onOpenChange={(open) => !open && setOpenDiff(null)}
        title={t('portability.transfer.diffTitle')}
        description={openDiff?.filePath}
        size="lg"
        footer={
          <Stack direction="row" gap="var(--spacing-xs)" justify="end">
            <Button variant="secondary" onClick={() => setOpenDiff(null)}>
              {t('common.close')}
            </Button>
          </Stack>
        }
      >
        {openDiff && (
          <Stack gap="var(--spacing-xs)">
            {openDiff.truncated && (
              <Typography variant="body-sm" color="subtle">
                {t('portability.transfer.truncated')}
              </Typography>
            )}
            {openDiff.unchanged && (
              <Typography variant="body-sm" color="subtle">
                {t('portability.transfer.unchangedFile')}
              </Typography>
            )}
            <div className={styles.diff}>
              {openDiff.lines.map((line, index) => (
                // Строки диффа не имеют идентификатора; индекс здесь устойчив —
                // список статичен и не переупорядочивается.
                <div key={index} className={styles.diffLine} data-kind={line.kind}>
                  <span className={styles.diffSign}>{DIFF_LINE_PREFIX[line.kind]}</span>
                  <span className={styles.diffText}>{line.text}</span>
                </div>
              ))}
            </div>
          </Stack>
        )}
      </Modal>

      <Modal
        isOpen={confirmApply}
        onOpenChange={(open) => !open && setConfirmApply(false)}
        title={t('portability.transfer.applyTitle', { target: targetName })}
        size="sm"
        footer={
          <Stack direction="row" gap="var(--spacing-xs)" justify="end">
            <Button variant="secondary" onClick={() => setConfirmApply(false)}>
              {t('common.cancel')}
            </Button>
            <Button variant="primary" isLoading={applying.isPending} onClick={apply}>
              {t('portability.transfer.apply')}
            </Button>
          </Stack>
        }
      >
        <Typography variant="body-sm">
          {t('portability.transfer.applyText', { count: summary?.files ?? 0 })}
        </Typography>
      </Modal>

      <Modal
        isOpen={confirmRevert}
        onOpenChange={(open) => !open && setConfirmRevert(false)}
        title={t('portability.transfer.revertTitle')}
        size="md"
        footer={
          <Stack direction="row" gap="var(--spacing-xs)" justify="end">
            <Button variant="secondary" onClick={() => setConfirmRevert(false)}>
              {t('common.cancel')}
            </Button>
            <Button variant="danger" isLoading={reverting.isPending} onClick={revert}>
              {t('portability.transfer.revertConfirm')}
            </Button>
          </Stack>
        }
      >
        <Stack gap="var(--spacing-xs)">
          <Typography variant="body-sm">{t('portability.transfer.revertText')}</Typography>

          {/* Правки человека — отдельным выбором, по файлу. Один общий
              выключатель «вернуть всё» заставлял бы его либо потерять свою
              правку, либо оставить чужую запись, — а это разные файлы. */}
          {changedSince.length > 0 && (
            <Stack gap="var(--spacing-3xs)">
              <Typography variant="body-sm" color="warning">
                {t('portability.transfer.changedSinceAsk')}
              </Typography>
              {changedSince.map((path) => (
                <label key={path} className={styles.alsoRevert}>
                  <input
                    type="checkbox"
                    checked={alsoRevert.includes(path)}
                    onChange={(event) =>
                      setAlsoRevert(
                        event.target.checked
                          ? [...alsoRevert, path]
                          : alsoRevert.filter((kept) => kept !== path),
                      )
                    }
                  />
                  <span className={styles.source}>{path}</span>
                </label>
              ))}
            </Stack>
          )}
        </Stack>
      </Modal>
    </Card>
  );
}

/**
 * Свежий план из отказа 409: сервер присылает его вместе с «файлы изменились».
 *
 * Разбор осторожный — это тело чужого ответа, а не наш тип: без проверки полей
 * раздел поставил бы на место плана что угодно, что там оказалось, и показал бы
 * человеку пустой экран вместо плана.
 */
function freshPlanOf(error: unknown): TransferPlan | null {
  const data: unknown = (error as { response?: { data?: unknown } })?.response?.data;
  if (typeof data !== 'object' || data === null) return null;
  const { plan } = data as { plan?: unknown };
  if (typeof plan !== 'object' || plan === null) return null;
  const candidate = plan as Partial<TransferPlan>;
  return typeof candidate.fingerprint === 'string' && Array.isArray(candidate.files)
    ? (plan as TransferPlan)
    : null;
}
