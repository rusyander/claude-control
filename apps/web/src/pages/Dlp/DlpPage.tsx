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
import { toast } from '@shared/lib/toast';
import { useSettings, useUpdateSettings } from '@entities/AppConfig';
import {
  useDlp,
  useSaveDlpRules,
  useSetDlpRunning,
  newTermsRule,
  newRegexRule,
  starterRules,
  replaceRule,
  removeRule,
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
 */
export function DlpPage() {
  const { t } = useTranslation();
  const { data: settings } = useSettings();
  const updateSettings = useUpdateSettings();
  const { data, isLoading } = useDlp();
  const saveRules = useSaveDlpRules();
  const setRunning = useSetDlpRunning();

  // Правила правятся черновиком и сохраняются кнопкой: сохранять по каждому
  // нажатию клавиши значило бы перезапускать прокси посреди набора словаря.
  const [draft, setDraft] = useState<DlpRule[] | undefined>(undefined);

  useEffect(() => {
    if (data && !draft) setDraft(data.rules);
  }, [data, draft]);

  if (isLoading || !data || !settings) return <SkeletonList rows={3} />;

  const rules = draft ?? data.rules;
  const dirty = JSON.stringify(rules) !== JSON.stringify(data.rules);
  const active = rules.filter((rule) => rule.enabled).length;

  const patchSettings = (patch: Partial<DlpSettings>): void => {
    updateSettings.mutate({ dlp: { ...data.settings, ...patch } });
  };

  const commit = (next: DlpRule[]): void => {
    saveRules.mutate(next, {
      onSuccess: () => {
        setDraft(undefined);
        toast.success(t('dlp.saved'));
      },
      onError: (error) => toast.error(messageOf(error, t('dlp.saveFailed'))),
    });
  };

  const toggleRunning = (running: boolean): void => {
    // Тумблер в настройках и живой слушатель — одно и то же состояние: иначе
    // после перезапуска панели прокси не поднялся бы, а раздел показывал бы,
    // что защита включена.
    patchSettings({ enabled: running });
    setRunning.mutate(running, {
      onError: (error) => {
        patchSettings({ enabled: false });
        toast.error(messageOf(error, t('dlp.startFailed')));
      },
    });
  };

  return (
    <Stack gap="var(--spacing-lg)">
      <PageHeader
        title={t('dlp.title')}
        subtitle={t('dlp.subtitle')}
        helpTopic="dlp"
        actions={
          <Stack direction="row" gap="var(--spacing-xs)">
            <Button
              variant="secondary"
              leftIcon={<Icon name="plus" size={24} />}
              onClick={() => setDraft([...rules, newTermsRule(t('dlp.newTermsName'))])}
            >
              {t('dlp.addTerms')}
            </Button>
            <Button
              variant="secondary"
              leftIcon={<Icon name="plus" size={24} />}
              onClick={() => setDraft([...rules, newRegexRule(t('dlp.newRegexName'))])}
            >
              {t('dlp.addRegex')}
            </Button>
          </Stack>
        }
      />

      <ExplainBox title={t('dlp.explainTitle')} text={t('dlp.explainText')} />

      <DlpStatusCard
        settings={data.settings}
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
              onClick={() =>
                commit(
                  starterRules({
                    email: t('dlp.builtinName.email'),
                    phone_ru: t('dlp.builtinName.phone_ru'),
                    inn: t('dlp.builtinName.inn'),
                    snils: t('dlp.builtinName.snils'),
                    card: t('dlp.builtinName.card'),
                    secret_key: t('dlp.builtinName.secret_key'),
                    terms: t('dlp.newTermsName'),
                  }),
                )
              }
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
            {dirty && data.status.running && (
              <Typography variant="caption" color="warning">
                {t('dlp.dirtyWhileRunning')}
              </Typography>
            )}
          </Stack>
        </Stack>
      )}

      <DlpPreviewCard rules={rules} />
      <DlpJournalCard enabled={data.settings.journal} />
      {/*
       * Гейт — второй, независимый механизм на тех же правилах, и стоит он
       * последним намеренно: он видит только набранный руками текст, то есть
       * заметно меньше прокси. Выше по странице его приняли бы за замену.
       */}
      <PromptGateCard />
    </Stack>
  );
}

/** Текст отказа сервера, если он его прислал: он точнее общей формулировки. */
function messageOf(error: unknown, fallback: string): string {
  const message = (error as { response?: { data?: { message?: string } } })?.response?.data
    ?.message;
  return message ?? fallback;
}
