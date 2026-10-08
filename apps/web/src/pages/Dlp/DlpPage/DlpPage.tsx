import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { DlpRule, DlpSettings } from '@agentdeck/contracts';
import { Stack } from '@shared/ui/stack';
import { Typography } from '@shared/ui/typography';
import { Button } from '@shared/ui/button';
import { Icon } from '@shared/ui/icon';
import { PageHeader } from '@shared/ui/page-header';
import { ExplainBox } from '@shared/ui/explain-box';
import { EmptyState } from '@shared/ui/empty-state';
import { SkeletonList } from '@shared/ui/skeleton';
import { LoadErrorCard } from '@shared/ui/load-error';
import { PageTabs, PageTabPanel } from '@shared/ui/page-tabs';
import { usePageTab } from '@shared/hooks/use-page-tab';
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
  missingBuiltins,
  replaceRule,
  removeRule,
  dlpErrorMessage,
  DLP_BUILTINS,
  type BuiltinNames,
} from '@entities/Dlp';
import { DlpStatusCard } from '../DlpStatusCard/DlpStatusCard';
import { DlpRuleRow } from '../DlpRuleRow/DlpRuleRow';
import { DlpPreviewCard } from '../DlpPreviewCard/DlpPreviewCard';
import { DlpJournalCard } from '../DlpJournalCard/DlpJournalCard';
import { PromptGateCard } from '../PromptGateCard/PromptGateCard';
import { DLP_TABS, DLP_TAB_ICONS } from '../model/tabs';

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
  const updateSettings = useUpdateSettings({ silentError: true });
  const { data, isLoading, isError, refetch } = useDlp();
  const saveRules = useSaveDlpRules();
  const setRunning = useSetDlpRunning();

  // Правила правятся черновиком и сохраняются кнопкой: сохранять по каждому
  // нажатию клавиши значило бы перезапускать прокси посреди набора словаря.
  // Черновик заводится первой правкой человека, а не при загрузке: засеянный
  // один раз, он прятал правило, записанное агентом, горел «не сохранено», и
  // «Сохранить» возвращал старый список поверх записи (ревью 28.09 F-81).
  // `base` — сохранённые правила, от которых черновик начат: разошлись с
  // сервером — страница говорит, что «Сохранить» заменит чужую запись.
  const [draft, setDraftState] = useState<{ rules: DlpRule[]; base: string } | undefined>(
    undefined,
  );
  const { active: activeTab, select: selectTab } = usePageTab('dlp', DLP_TABS);
  const savedJson = data ? JSON.stringify(data.rules) : '';
  // Сохранённое — через ref: черновик после сохранения ставится из onSuccess, и
  // замыкание того нажатия ещё помнит список до записи.
  const savedRef = useRef(savedJson);
  savedRef.current = savedJson;
  const setDraft = (next: DlpRule[] | undefined): void =>
    setDraftState((current) => {
      if (next === undefined) return undefined;
      // Черновик, совпавший с сохранённым, начинается заново от него.
      const keepsBase = current && JSON.stringify(current.rules) !== savedRef.current;
      return { rules: next, base: keepsBase ? current.base : savedRef.current };
    });

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
  const rules = draft?.rules ?? data.rules;
  const dirty = JSON.stringify(rules) !== savedJson;
  const changedElsewhere = dirty && draft !== undefined && draft.base !== savedJson;
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

  // Готовый набор — все встроенные образцов, сохранённых сразу, плюс пустой
  // словарь черновиком: без слов сервер его не примет, а без него человек не
  // узнает, что своё добавляется именно здесь.
  const missing = missingBuiltins(rules);
  const addMissing = (): void =>
    setDraft([
      ...rules,
      ...missing.map((builtin) =>
        newBuiltinRule(builtin, builtinNames[builtin], builtinLabels[builtin]),
      ),
    ]);

  const addStarter = (): void => {
    const builtins = starterRules(builtinNames, builtinLabels);
    commit(builtins, () =>
      setDraft([...builtins, newTermsRule(t('dlp.newTermsName'), defaultLabel)]),
    );
  };

  const addActions = (
    <Stack direction="row" gap="var(--spacing-xs)" wrap>
      <Button
        variant="secondary"
        leftIcon={<Icon name="plus" size={24} />}
        onClick={() => setDraft([...rules, newTermsRule(t('dlp.newTermsName'), defaultLabel)])}
      >
        {t('dlp.addTerms')}
      </Button>
      <Button
        variant="secondary"
        leftIcon={<Icon name="plus" size={24} />}
        onClick={() => setDraft([...rules, newRegexRule(t('dlp.newRegexName'), defaultLabel)])}
      >
        {t('dlp.addRegex')}
      </Button>
      <Button
        variant="secondary"
        leftIcon={<Icon name="plus" size={24} />}
        onClick={() =>
          setDraft([...rules, newBuiltinRule('email', builtinNames.email, builtinLabels.email)])
        }
      >
        {t('dlp.addBuiltin')}
      </Button>
    </Stack>
  );

  const rulesPanel =
    rules.length === 0 ? (
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
        {addActions}
        {missing.length > 0 && (
          <Stack direction="row" align="center" gap="var(--spacing-xs)" wrap>
            <Typography variant="body-sm" color="subtle">
              {t('dlp.missingBuiltins', {
                count: missing.length,
                names: missing.map((builtin) => builtinNames[builtin]).join(', '),
              })}
            </Typography>
            <Button
              variant="secondary"
              size="sm"
              leftIcon={<Icon name="plus" size={16} />}
              onClick={addMissing}
            >
              {t('dlp.addMissing')}
            </Button>
          </Stack>
        )}
        {rules.map((rule) => (
          <DlpRuleRow
            key={rule.id}
            rule={rule}
            builtins={data.builtins}
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
        {changedElsewhere && (
          <Typography variant="body-sm" color="warning" role="status">
            {t('dlp.changedElsewhere')}
          </Typography>
        )}
      </Stack>
    );

  // Нет ни одного включённого правила — это видно на обеих вкладках, где от
  // правил что-то зависит: прокси без них не запустится, а сами правила — там,
  // где их включают.
  const noActiveLine = active === 0 && (
    <Typography variant="body-sm" color="warning">
      {t('dlp.noActiveRules')}
    </Typography>
  );

  // Несохранённый черновик виден с любой вкладки: иначе правки легко оставить
  // за соседней вкладкой и уйти со страницы, так их и не сохранив.
  const rulesMark = dirty ? { note: t('pageTabs.dlp.unsaved') } : { count: rules.length };
  const tabs = DLP_TABS.map((id) => ({
    id,
    label: t(`pageTabs.dlp.tab.${id}`),
    icon: DLP_TAB_ICONS[id],
    ...(id === 'rules' ? rulesMark : {}),
  }));

  return (
    <Stack gap="var(--spacing-lg)">
      <PageHeader title={t('dlp.title')} subtitle={t('dlp.subtitle')} helpTopic="dlp" />

      <ExplainBox title={t('dlp.explainTitle')} text={t('dlp.explainText')} />

      <PageTabs
        page="dlp"
        label={t('pageTabs.dlp.tabsLabel')}
        tabs={tabs}
        active={activeTab}
        onSelect={selectTab}
      />

      <PageTabPanel page="dlp" tab={activeTab} hint={t(`pageTabs.dlp.hint.${activeTab}`)}>
        {activeTab === 'proxy' && (
          <>
            <DlpStatusCard
              settings={dlp}
              status={data.status}
              profiles={settings.endpointProfiles}
              canStart={active > 0}
              isBusy={setRunning.isPending}
              onChange={patchSettings}
              onToggleRunning={toggleRunning}
            />
            {noActiveLine}
          </>
        )}

        {activeTab === 'rules' && (
          <>
            {noActiveLine}
            {rulesPanel}
          </>
        )}

        {activeTab === 'check' && <DlpPreviewCard rules={rules} />}
        {activeTab === 'journal' && <DlpJournalCard enabled={dlp.journal} live={running} />}
        {/*
         * Гейт — второй, независимый механизм на тех же правилах, и стоит он
         * последней вкладкой намеренно: он видит только набранный руками текст,
         * то есть заметно меньше прокси. Рядом с прокси его приняли бы за замену.
         */}
        {activeTab === 'gate' && <PromptGateCard />}
      </PageTabPanel>
    </Stack>
  );
}
