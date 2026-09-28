import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { MemberAdvice } from '@agentdeck/contracts';
import { Modal } from '@shared/ui/modal';
import { Stack } from '@shared/ui/stack';
import { Typography } from '@shared/ui/typography';
import { Button } from '@shared/ui/button';
import { Badge } from '@shared/ui/badge';
import { SelectField } from '@shared/ui/select-field';
import { toErrorMessage } from '@shared/api/client';
import {
  useApplyAdvice,
  useCopyToGlobal,
  useMergeOrigin,
  type GroupAdviceResult,
} from '@entities/Group';
import { useProviders } from '@entities/Provider';
import { warningDetailText } from './model/warningDetail';
import type { AdviceModalProps } from './AdviceModal.types';
import styles from './AdviceModal.module.scss';

const DEFAULT_PROVIDER = 'claude';

const VERDICT_TONE = { ours: 'accent', improve: 'warning', keep: 'neutral' } as const;

/**
 * Копия в общие и слияние изменений оригинала — один и тот же разговор:
 * агент по каждому участнику говорит «взять наш / улучшить / оставить» с
 * причиной, человек отмечает, одна кнопка применяет. Правки ложатся ТОЛЬКО в
 * глобальную копию; «оставить» применять нечего — у него нет флажка.
 */
export function AdviceModal({ mode, group, onClose }: AdviceModalProps) {
  const { t } = useTranslation();
  const [provider, setProvider] = useState(DEFAULT_PROVIDER);
  const [result, setResult] = useState<GroupAdviceResult | undefined>(undefined);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const { data: providers } = useProviders();
  const copy = useCopyToGlobal();
  const merge = useMergeOrigin();
  const apply = useApplyAdvice();

  const receive = useCallback((next: GroupAdviceResult): void => {
    setResult(next);
    // Отмечено по умолчанию всё, что агент советует менять: человек снимает
    // лишнее, а не собирает нужное по одному. Кроме замен, которые исполняются
    // (хук, MCP): их человек отмечает сам, прочитав команду.
    setPicked(
      new Set(
        next.advice.filter((item) => item.verdict !== 'keep' && !runsCode(item)).map(adviceKey),
      ),
    );
  }, []);

  // Слиянию выбирать нечего — предложение просим сразу при открытии.
  const mergeGroupId = mode === 'merge' ? group.id : undefined;
  const mergeRun = merge.mutateAsync;
  const [isMerging, setIsMerging] = useState(false);
  // Отказ слияния — в самом окне: без него тело окна оставалось пустым, а
  // общий тост уходил раньше, чем человек его читал.
  const [mergeError, setMergeError] = useState<unknown>(undefined);
  const askMerge = useCallback(
    (id: string): void => {
      setIsMerging(true);
      setMergeError(undefined);
      mergeRun(id)
        .then(receive)
        .catch((error: unknown) => setMergeError(error ?? new Error('merge failed')))
        .finally(() => setIsMerging(false));
    },
    [mergeRun, receive],
  );
  // Предложение слияния — вызов модели: двойной эффект строгого режима в
  // разработке не должен звать его дважды. Ответ ловится обещанием, а не
  // колбэком `mutate`: наблюдатель мутации отписывается при пробном размонтировании
  // строгого режима, и колбэк первого вызова терялся — окно вечно «сравнивало».
  const mergeAsked = useRef(false);
  useEffect(() => {
    if (!mergeGroupId || mergeAsked.current) return;
    mergeAsked.current = true;
    askMerge(mergeGroupId);
  }, [mergeGroupId, askMerge]);

  const title =
    mode === 'copy'
      ? t('groupSources.copyTitle', { name: group.name })
      : t('groupSources.mergeTitle', { name: group.name });
  const isWorking = copy.isPending || isMerging;
  const providerOptions = (providers?.providers ?? []).map((item) => ({
    value: item.id,
    label: item.name,
  }));

  // Пустой список советов — три разных случая, и каждый назван своим текстом.
  const emptyAdviceText = (shown: GroupAdviceResult): string => {
    // Чужому CLI сервер советов не даёт вовсе — «Советов нет» звучало бы как
    // вывод модели, которой никто не спрашивал.
    if (mode === 'copy' && provider !== DEFAULT_PROVIDER) {
      return t('groupSources.adviceEmptyForeign');
    }
    // Сбой модели — тоже не «советов нет»: копию никто не посмотрел.
    if (shown.adviceFailed) return t('groupSources.adviceFailed');
    return t('groupSources.adviceEmpty');
  };

  const toggle = (item: MemberAdvice): void => {
    setPicked((current) => {
      const next = new Set(current);
      const key = adviceKey(item);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  // Двойной щелчок успевает раньше перерисовки, которая заняла бы кнопку, а
  // дважды применённый совет правит копию дважды.
  const applying = useRef(false);
  const applyPicked = (): void => {
    if (!result || applying.current) return;
    applying.current = true;
    const items = result.advice
      .filter((item) => picked.has(adviceKey(item)))
      .map((item) => ({ kind: item.kind, id: item.id }));
    apply.mutate(
      { id: result.group.id, items },
      {
        onSuccess: onClose,
        onError: () => {
          applying.current = false;
        },
      },
    );
  };

  return (
    <Modal
      isOpen
      onOpenChange={(open) => !open && onClose()}
      title={title}
      description={mode === 'copy' ? t('groupSources.copyIntro') : t('groupSources.mergeIntro')}
      size="lg"
      footer={
        <>
          <Button onClick={onClose}>
            {result ? t('groupSources.adviceClose') : t('common.cancel')}
          </Button>
          {mode === 'copy' && !result && (
            <Button
              variant="primary"
              isLoading={copy.isPending}
              onClick={() => copy.mutate({ id: group.id, provider }, { onSuccess: receive })}
            >
              {t('groupSources.copyRun')}
            </Button>
          )}
          {result && result.advice.length > 0 && (
            <Button
              variant="primary"
              disabled={picked.size === 0}
              isLoading={apply.isPending}
              onClick={applyPicked}
            >
              {t('groupSources.adviceApply', { count: picked.size })}
            </Button>
          )}
        </>
      }
    >
      <Stack gap="var(--spacing-md)">
        {mode === 'copy' && !result && (
          <SelectField
            label={t('groupSources.targetProvider')}
            value={provider}
            onChange={setProvider}
            options={
              providerOptions.length > 0
                ? providerOptions
                : [{ value: DEFAULT_PROVIDER, label: 'Claude Code' }]
            }
          />
        )}

        {isWorking && (
          <Typography variant="body-sm" color="subtle" aria-busy="true">
            {mode === 'copy' ? t('groupSources.copying') : t('groupSources.merging')}
          </Typography>
        )}

        {mergeGroupId && mergeError !== undefined && !isMerging && (
          <Stack direction="row" align="center" gap="var(--spacing-xs)" wrap>
            <Typography variant="body-sm" color="danger" role="alert">
              {t('groupSources.mergeFailed', { reason: toErrorMessage(mergeError) })}
            </Typography>
            <Button size="sm" onClick={() => askMerge(mergeGroupId)}>
              {t('common.retry')}
            </Button>
          </Stack>
        )}

        {result && (
          <Stack gap="var(--spacing-sm)">
            {(result.warnings ?? []).length > 0 && (
              <ul className={styles.list} aria-label={t('groupSources.warningsTitle')}>
                {(result.warnings ?? []).map((warning) => (
                  <li key={`${warning.kind}:${warning.member}`}>
                    <Typography variant="body-sm" color="subtle" as="span">
                      {t(`groupSources.warning_${warning.kind}`, {
                        member: warning.member,
                        to: warning.to ?? '',
                        detail: warningDetailText(warning.detail, t),
                      })}
                    </Typography>
                  </li>
                ))}
              </ul>
            )}
            <Typography variant="body-sm" weight="medium">
              {t('groupSources.adviceTitle')}
            </Typography>
            {result.advice.length === 0 ? (
              <Typography variant="body-sm" color="subtle">
                {emptyAdviceText(result)}
              </Typography>
            ) : (
              <>
                <Typography variant="caption" color="subtle">
                  {t('groupSources.adviceIntro')}
                </Typography>
                <ul className={styles.list}>
                  {result.advice.map((item) => (
                    <AdviceRow
                      key={adviceKey(item)}
                      item={item}
                      isPicked={picked.has(adviceKey(item))}
                      onToggle={() => toggle(item)}
                    />
                  ))}
                </ul>
              </>
            )}
          </Stack>
        )}
      </Stack>
    </Modal>
  );
}

interface AdviceRowProps {
  item: MemberAdvice;
  isPicked: boolean;
  onToggle: () => void;
}

function AdviceRow({ item, isPicked, onToggle }: AdviceRowProps) {
  const { t } = useTranslation();
  const verdict = (
    <Badge tone={VERDICT_TONE[item.verdict]}>{t(`groupSources.verdict_${item.verdict}`)}</Badge>
  );
  const name = (
    <Typography variant="body-sm" weight="medium" as="span">
      {item.id}
    </Typography>
  );

  return (
    <li className={styles.row}>
      {item.verdict === 'keep' ? (
        <div className={styles.head}>
          <span className={styles.spacer} aria-hidden="true" />
          {name}
          {verdict}
          <Typography variant="caption" color="subtle" as="span">
            {t('groupSources.adviceKeep')}
          </Typography>
        </div>
      ) : (
        <label className={styles.head}>
          <input type="checkbox" checked={isPicked} onChange={onToggle} />
          {name}
          {verdict}
        </label>
      )}
      <Typography variant="body-sm" color="muted" className={styles.reason}>
        {item.reason}
      </Typography>
      {item.verdict === 'ours' && item.replacement && (
        <Typography variant="caption" color="subtle" className={styles.reason}>
          {t('groupSources.adviceOursWith', { id: item.replacement })}
        </Typography>
      )}
      {item.verdict === 'improve' && item.replacement && (
        <details className={styles.replacement} open={runsCode(item)}>
          <summary>
            <Typography variant="caption" color="subtle" as="span">
              {runsCode(item)
                ? t('groupSources.adviceReplacementRuns')
                : t('groupSources.adviceReplacement')}
            </Typography>
          </summary>
          <pre className={styles.code}>{readable(item.replacement)}</pre>
        </details>
      )}
    </li>
  );
}

/** Замена хука и MCP приходит JSON в одну строку — человеку показываем с отступами. */
function readable(text: string): string {
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
}

/** Замена, которая будет выполняться на машине: команда хука, запуск MCP. */
function runsCode(item: MemberAdvice): boolean {
  return item.verdict === 'improve' && (item.kind === 'hook' || item.kind === 'mcp');
}

function adviceKey(item: { kind: string; id: string }): string {
  return `${item.kind}:${item.id}`;
}
