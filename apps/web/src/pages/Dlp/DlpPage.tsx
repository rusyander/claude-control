import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { DlpRule, DlpSettings } from '@claude-control/contracts';
import { Stack } from '@shared/ui/stack';
import { Typography } from '@shared/ui/typography';
import { Button } from '@shared/ui/button';
import { Icon } from '@shared/ui/icon';
import { PageHeader } from '@shared/ui/page-header';
import { ExplainBox } from '@shared/ui/explain-box';
import { EmptyState } from '@shared/ui/empty-state';
import { SkeletonList } from '@shared/ui/skeleton';
import { LoadErrorCard } from '@shared/ui/load-error';
import { toast } from '@shared/lib/toast';
import { useSettings, useUpdateSettings } from '@entities/AppConfig';
import {
  useDlp,
  useSaveDlpRules,
  useSetDlpRunning,
  newTermsRule,
  newRegexRule,
  newBuiltinRule,
  starterRules,
  replaceRule,
  removeRule,
  dlpErrorMessage,
  DLP_BUILTINS,
  type BuiltinNames,
} from '@entities/Dlp';
import { DlpStatusCard } from './DlpStatusCard';
import { DlpRuleRow } from './DlpRuleRow';
import { DlpPreviewCard } from './DlpPreviewCard';
import { DlpJournalCard } from './DlpJournalCard';
import { PromptGateCard } from './PromptGateCard';

/**
 * Защита данных: локальный прокси между CLI и моделью.
 *
 * Раздел обязан говорить прямо, чего он НЕ делает. Прокси видит тело запроса —
 * промпт, содержимое прочитанных агентом файлов, вывод инструментов, — и это
 * принципиально больше, чем видит хук на промпте. Но он находит только то, что
 * описано правилами: незаписанную фамилию он не угадает, а перефразированную
 * моделью метку не вернёт обратно. Раздел с этим и живёт — обещать полноту
 * значило бы продавать спокойствие вместо защиты.
 *
 * Настройки прокси берутся из общих настроек панели (`useSettings`), а не из
 * ответа `/api/dlp`: после PATCH обновляется именно кеш настроек, и карточка,
 * читавшая снимок `/api/dlp`, отскакивала тумблером назад до следующего F5.
 */
export function DlpPage() {
  const { t } = useTranslation();
  const { data: settings, isError: isSettingsError, refetch: refetchSettings } = useSettings();
  const updateSettings = useUpdateSettings();
  const { data, isLoading, isError, refetch } = useDlp();
  const saveRules = useSaveDlpRules();
  const setRunning = useSetDlpRunning();

  // Правила правятся черновиком и сохраняются кнопкой: сохранять по каждому
  // нажатию клавиши значило бы перезапускать прокси посреди набора словаря.
  const [draft, setDraft] = useState<DlpRule[] | undefined>(undefined);

  useEffect(() => {
    if (data && !draft) setDraft(data.rules);
  }, [data, draft]);

  // Отказ сервера — не вечный скелет: заголовок с «?» и кнопка повторить.
  if ((isError && !data) || (isSettingsError && !settings)) {
    return (
      <Stack gap="var(--spacing-lg)">
        <PageHeader title={t('dlp.title')} subtitle={t('dlp.subtitle')} helpTopic="dlp" />
        <LoadErrorCard
          onRetry={() => {
            void refetch();
            void refetchSettings();
          }}
        />
      </Stack>
    );
  }

  if (isLoading || !data || !settings) return <SkeletonList rows={3} />;

  const dlp = settings.dlp;
  const running = data.status.running;
  const rules = draft ?? data.rules;
  const dirty = JSON.stringify(rules) !== JSON.stringify(data.rules);
  const active = rules.filter((rule) => rule.enabled).length;
  const defaultLabel = t('dlp.defaultLabel');
  const builtinNames = Object.fromEntries(
    DLP_BUILTINS.map((builtin) => [builtin, t(`dlp.builtinName.${builtin}`)]),
  ) as BuiltinNames;
  const builtinLabels = Object.fromEntries(
    DLP_BUILTINS.map((builtin) => [builtin, t(`dlp.builtinLabel.${builtin}`)]),
  ) as BuiltinNames;

  /**
   * Работающий прокси живёт со снимком настроек, снятым при запуске. Настройку
   * поменяли — перезапускаем сразу, как это делает сохранение правил: иначе
   * тумблер показывал бы одну политику, а слушатель применял другую.
   */
  const restartProxy = (): void => {
    setRunning.mutate(true, {
      onError: (error) => {
        patchSettings({ enabled: false }, { restart: false });
        toast.error(dlpErrorMessage(error, t('dlp.restartFailed')));
      },
    });
  };

  const patchSettings = (
    patch: Partial<DlpSettings>,
    options: { restart?: boolean } = {},
  ): void => {
    updateSettings.mutate(
      { dlp: { ...dlp, ...patch } },
      {
        onSuccess: () => {
          if (options.restart !== false && running) restartProxy();
        },
        onError: (error) => toast.error(dlpErrorMessage(error, t('dlp.settingsFailed'))),
      },
    );
  };

  const commit = (next: DlpRule[], afterSave?: () => void): void => {
    saveRules.mutate(next, {
      onSuccess: () => {
        setDraft(undefined);
        afterSave?.();
        toast.success(t('dlp.saved'));
      },
      onError: (error) => toast.error(dlpErrorMessage(error, t('dlp.saveFailed'))),
    });
  };

  const toggleRunning = (next: boolean): void => {
    // Тумблер в настройках и живой слушатель — одно и то же состояние: иначе
    // после перезапуска панели прокси не поднялся бы, а раздел показывал бы,
    // что защита включена.
    patchSettings({ enabled: next }, { restart: false });
    setRunning.mutate(next, {
      onError: (error) => {
        patchSettings({ enabled: false }, { restart: false });
        toast.error(dlpErrorMessage(error, t('dlp.startFailed')));
      },
    });
  };

  // Готовый набор — шесть встроенных образцов, сохранённых сразу, плюс пустой
  // словарь черновиком: без слов сервер его не примет, а без него человек не
  // узнает, что своё добавляется именно здесь.
  const addStarter = (): void => {
    const builtins = starterRules(builtinNames, builtinLabels);
    commit(builtins, () =>
      setDraft([...builtins, newTermsRule(t('dlp.newTermsName'), defaultLabel)]),
    );
  };

  return (
    <Stack gap="var(--spacing-lg)">
      <PageHeader
        title={t('dlp.title')}
        subtitle={t('dlp.subtitle')}
        helpTopic="dlp"
        actions={
          <Stack direction="row" gap="var(--spacing-xs)" wrap>
            <Button
              variant="secondary"
              leftIcon={<Icon name="plus" size={24} />}
              onClick={() =>
                setDraft([...rules, newTermsRule(t('dlp.newTermsName'), defaultLabel)])
              }
            >
              {t('dlp.addTerms')}
            </Button>
            <Button
              variant="secondary"
              leftIcon={<Icon name="plus" size={24} />}
              onClick={() =>
                setDraft([...rules, newRegexRule(t('dlp.newRegexName'), defaultLabel)])
              }
            >
              {t('dlp.addRegex')}
            </Button>
            <Button
              variant="secondary"
              leftIcon={<Icon name="plus" size={24} />}
              onClick={() =>
                setDraft([
                  ...rules,
                  newBuiltinRule('email', builtinNames.email, builtinLabels.email),
                ])
              }
            >
              {t('dlp.addBuiltin')}
            </Button>
          </Stack>
        }
      />

      <ExplainBox title={t('dlp.explainTitle')} text={t('dlp.explainText')} />

      <DlpStatusCard
        settings={dlp}
        status={data.status}
        profiles={settings.endpointProfiles}
        canStart={active > 0}
        isBusy={setRunning.isPending}
        onChange={patchSettings}
        onToggleRunning={toggleRunning}
      />

      {active === 0 && (
        <Typography variant="body-sm" color="warning">
          {t('dlp.noActiveRules')}
        </Typography>
      )}

      {rules.length === 0 ? (
        <EmptyState
          icon="lock"
          title={t('dlp.emptyTitle')}
          text={t('dlp.emptyText')}
          action={
            <Button
              variant="primary"
              leftIcon={<Icon name="plus" size={24} />}
              onClick={addStarter}
              isLoading={saveRules.isPending}
            >
              {t('dlp.addStarter')}
            </Button>
          }
        />
      ) : (
        <Stack gap="var(--spacing-sm)">
          {rules.map((rule) => (
            <DlpRuleRow
              key={rule.id}
              rule={rule}
              builtinNames={builtinNames}
              builtinLabels={builtinLabels}
              onChange={(next) => setDraft(replaceRule(rules, next))}
              onRemove={(id) => setDraft(removeRule(rules, id))}
            />
          ))}

          <Stack direction="row" align="center" gap="var(--spacing-xs)" wrap>
            <Button
              variant="primary"
              leftIcon={<Icon name="check" size={20} />}
              onClick={() => commit(rules)}
              disabled={!dirty}
              isLoading={saveRules.isPending}
            >
              {t('dlp.save')}
            </Button>
            {dirty && (
              <Button variant="ghost" onClick={() => setDraft(undefined)}>
                {t('dlp.discard')}
              </Button>
            )}
            {dirty && running && (
              <Typography variant="caption" color="warning">
                {t('dlp.dirtyWhileRunning')}
              </Typography>
            )}
          </Stack>
        </Stack>
      )}

      <DlpPreviewCard rules={rules} />
      <DlpJournalCard enabled={dlp.journal} live={running} />
      {/*
       * Гейт — второй, независимый механизм на тех же правилах, и стоит он
       * последним намеренно: он видит только набранный руками текст, то есть
       * заметно меньше прокси. Выше по странице его приняли бы за замену.
       */}
      <PromptGateCard />
    </Stack>
  );
}
