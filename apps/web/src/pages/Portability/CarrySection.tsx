import { useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { HANDOFF_MAX_CHAIN } from '@agentdeck/contracts/chat-handoff';
import type { CarryCandidate } from '@agentdeck/contracts/portable-carry';
import { Card } from '@shared/ui/card';
import { Stack } from '@shared/ui/stack';
import { Badge } from '@shared/ui/badge';
import { Button } from '@shared/ui/button';
import { Toggle } from '@shared/ui/toggle';
import { Typography } from '@shared/ui/typography';
import { SkeletonList } from '@shared/ui/skeleton';
import { LoadErrorCard } from '@shared/ui/load-error';
import { toErrorMessage } from '@shared/api/client';
import { formatDateTime } from '@shared/lib/format';
import { toast } from '@shared/lib/toast';
import { useApplyCarry, useCarryPlan } from '@entities/Portability';
import styles from './PortabilityPage.module.scss';

interface CarrySectionProps {
  /** Все провайдеры парами «id — имя»: цель раздел называет САМ. */
  providers: readonly { value: string; label: string }[];
}

/**
 * Незакрытая работа переезжает вместе со средой (П6.1).
 *
 * ТРИ ПРАВИЛА, ради которых раздел устроен именно так:
 *
 *  1. **Обещание сформулировано вычитанием.** Первое, что читает человек, — что
 *     переписка НЕ переезжает. Карточка, начинающаяся со слова «перенести», без
 *     этой строки обещает переезд разговора целиком, а переезжает опора и
 *     задание.
 *  2. **Непригодный разговор остаётся в списке с причиной.** Панель знает, что
 *     мешает (потолок цепочки, нет опоры, опора не менялась), и молчаливое
 *     исчезновение строки человек прочитал бы как «этой работы у меня нет».
 *  3. **Заметка, которой некуда было лечь, названа вслух.** У Claude лента —
 *     транскрипт самого CLI: перенос состоялся, а следа в старом разговоре не
 *     осталось, и знать об этом человеку важнее, чем видеть ровный зелёный тост.
 */
export function CarrySection({ providers }: CarrySectionProps) {
  const { t, i18n } = useTranslation();

  const plan = useCarryPlan();
  const applying = useApplyCarry();
  const [chosen, setChosen] = useState<string[]>([]);

  // Цель переноса работы — АКТИВНЫЙ CLI, а не цель переноса среды, выбранная
  // выше на странице. Имя берётся из ответа сервера: назови раздел выбранную
  // человеком цель — и он прочитал бы, что работа уедет туда, куда она не
  // уедет.
  const target = plan.data?.target ?? '';
  const targetName = providers.find((item) => item.value === target)?.label ?? target;
  const candidates = plan.data?.candidates ?? [];
  const picked = chosen.filter((key) =>
    candidates.some((candidate) => candidate.key === key && candidate.ready),
  );

  const toggle = (key: string): void => {
    setChosen((previous) =>
      previous.includes(key) ? previous.filter((item) => item !== key) : [...previous, key],
    );
  };

  const carry = (): void => {
    if (picked.length === 0) return;
    applying.mutate(picked, {
      onSuccess: (answer) => {
        setChosen([]);
        const carried = answer.outcomes.filter((outcome) => outcome.carried);
        if (carried.length > 0) {
          toast.success(t('portability.carry.carriedToast', { count: carried.length }));
        }
        const refused = answer.outcomes.filter((outcome) => !outcome.carried);
        if (refused.length > 0) {
          // Отказ цели НАЗЫВАЕТСЯ: у строки разговора причины нет — она про
          // предохранители, а эти три беды случились уже у цели.
          const failures = [...new Set(refused.map((outcome) => outcome.failure))].filter(
            (failure): failure is NonNullable<typeof failure> => failure !== undefined,
          );
          toast.error(
            [
              t('portability.carry.refusedToast', { count: refused.length }),
              ...failures.map((failure) => t(`portability.carry.failure.${failure}`)),
            ].join(' '),
          );
        }
        // Перенос состоялся, а сказать об этом в старом разговоре было некуда.
        if (carried.some((outcome) => !outcome.noticedSource)) {
          toast.info(t('portability.carry.notNoticed'));
        }
      },
      onError: (error) => toast.error(toErrorMessage(error)),
    });
  };

  const row = (candidate: CarryCandidate) => (
    <div key={candidate.key} className={styles.carryRow}>
      <Stack gap="var(--spacing-3xs)">
        <label className={styles.layer}>
          <Toggle
            checked={chosen.includes(candidate.key)}
            onCheckedChange={() => toggle(candidate.key)}
            disabled={!candidate.ready || applying.isPending}
            size="sm"
            aria-label={candidate.title}
          />
          <span>{candidate.title}</span>
        </label>
        <Typography variant="caption" className={styles.source}>
          {candidate.cwd}
        </Typography>
        {/* Опора названа в строке: переезжает именно она, и человек вправе
            заранее знать, ЧТО прочитает новый разговор. */}
        <Typography variant="caption" className={styles.source}>
          {t('portability.carry.checkpoint', { file: candidate.checkpoint })}
        </Typography>
        {/* Отказ стоит на месте, где человек ищет ответ «почему не выбирается», —
            в самой строке, а не в тосте, который исчезнет. */}
        {!candidate.ready && (
          <Typography variant="body-sm" color="warning">
            {t(`portability.carry.refusal.${candidate.reason}`, {
              defaultValue: t('portability.carry.refusal.checkpoint_missing'),
            })}
          </Typography>
        )}
      </Stack>

      <Stack direction="row" gap="var(--spacing-3xs)" className={styles.summary}>
        <Badge tone="neutral">{candidate.providerId}</Badge>
        <Badge tone="neutral">{formatDateTime(candidate.updatedAt, i18n.language)}</Badge>
        {candidate.chainDepth > 0 && (
          <Badge tone="neutral">
            {t('portability.carry.chain', {
              depth: candidate.chainDepth,
              max: HANDOFF_MAX_CHAIN,
            })}
          </Badge>
        )}
      </Stack>
    </div>
  );

  // Не дочитанный ответ — это НЕ «работы нет»: пустой список и пустое имя цели
  // читаются как ответ сервера, и человек ушёл бы с экрана уверенным, что
  // переносить нечего. Поэтому оба незавершённых состояния названы своими
  // словами — ровно как у паспорта и отчёта верности на этой же странице.
  const body = (): ReactNode => {
    if (plan.isLoading) return <SkeletonList rows={3} />;
    if (plan.isError) {
      return (
        <LoadErrorCard
          title={t('portability.carry.loadError')}
          text={t('portability.carry.loadErrorText')}
          onRetry={() => {
            void plan.refetch();
          }}
        />
      );
    }

    return (
      <>
        <Typography variant="body-sm">
          {t('portability.carry.target', { target: targetName })}
        </Typography>

        {candidates.length === 0 ? (
          <Typography variant="body-sm" color="subtle">
            {t('portability.carry.empty')}
          </Typography>
        ) : (
          <>
            <Stack gap="var(--spacing-2xs)" className={styles.rows}>
              {candidates.map(row)}
            </Stack>
            <Stack direction="row" gap="var(--spacing-xs)">
              <Button
                variant="primary"
                isLoading={applying.isPending}
                disabled={picked.length === 0}
                onClick={carry}
              >
                {t('portability.carry.carry', { count: picked.length })}
              </Button>
            </Stack>
          </>
        )}
      </>
    );
  };

  return (
    <Card padding="md">
      <Stack gap="var(--spacing-sm)">
        <Typography variant="heading-sm">{t('portability.carry.title')}</Typography>

        <Typography variant="body-sm" color="subtle">
          {t('portability.carry.intro')}
        </Typography>

        {body()}
      </Stack>
    </Card>
  );
}
