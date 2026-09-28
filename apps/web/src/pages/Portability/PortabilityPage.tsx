import { useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import type { EnvItemKind } from '@agentdeck/contracts/portable-env';
import { Stack } from '@shared/ui/stack';
import { PageHeader } from '@shared/ui/page-header';
import { SkeletonList } from '@shared/ui/skeleton';
import { LoadErrorCard } from '@shared/ui/load-error';
import { PageTabs, PageTabPanel } from '@shared/ui/page-tabs';
import { usePageTab } from '@shared/hooks/use-page-tab';
import { EmptyState } from '@shared/ui/empty-state';
import { useSettings } from '@entities/AppConfig';
import { useProviders } from '@entities/Provider';
import { useProjectRegistry } from '@entities/Project';
import {
  usePortabilityPassport,
  useFidelityReport,
  kindLabelKey,
  usableTarget,
  type PortabilityLevel,
} from '@entities/Portability';
import { PassportSection } from './PassportSection';
import { FidelityTable } from './FidelityTable';
import { TransferSection } from './TransferSection';
import { SubscriptionSection } from './SubscriptionSection';
import { CarrySection } from './CarrySection';
import { ProbeSection } from './ProbeSection';
import { PortabilityPicker } from './PortabilityPicker';
import { passportSections } from './model/passport-sections';
import { PORTABILITY_TABS, PORTABILITY_TAB_ICONS, TARGET_TABS } from './model/tabs';
import { readRememberedTarget, rememberTarget } from './model/target-memory';

/**
 * Паспорт среды: что у человека НА САМОМ ДЕЛЕ настроено у одного CLI (П0.3).
 *
 * Раздел панель-level и не гейтится возможностями активного провайдера: смысл
 * страницы в том, чтобы посмотреть и на ДРУГОЙ установленный CLI — иначе она
 * отвечала бы только на вопрос «что у меня сейчас», а спрашивают её перед
 * переходом.
 *
 * Страница ничего не пишет и ничего не запускает: сервер только читает файлы.
 *
 * ДВА ПРАВИЛА ПОКАЗА, ради которых экран и существует:
 *
 *  1. **Пропуски видны наравне с записями.** Раздел, который панель не
 *     прочитала, показан своей причиной, а не отсутствием строки: пустое место
 *     человек читает как «у меня этого нет», и это была бы ложь о среде.
 *  2. **`needs` записи показан как есть.** «Ничего не нужно» и «определить не
 *     удалось» — разные строки разного цвета: из первого следует, что запись
 *     переедет куда угодно, из второго — что переносить её вслепую нельзя.
 */
export function PortabilityPage() {
  const { t } = useTranslation();
  const { data: settings, isError: settingsFailed, refetch: refetchSettings } = useSettings();
  const { data: providers, isError: providersFailed, refetch: refetchProviders } = useProviders();

  const [chosen, setChosen] = useState('');
  const { active: activeTab, select: selectTab } = usePageTab('portability', PORTABILITY_TABS);

  // Уровень записи. Дом по умолчанию — не «для удобства»: страница отвечает на
  // вопрос «что у меня настроено», а настроенное у человека в первую очередь
  // домашнее; проект он выбирает сам, и до выбора запроса о нём нет.
  const [scope, setScope] = useState<PortabilityLevel['scope']>('global');
  const [project, setProject] = useState('');
  const { data: projects } = useProjectRegistry();
  const level: PortabilityLevel = { scope, project: scope === 'project' ? project : undefined };

  const options = useMemo(
    () => (providers?.providers ?? []).map((item) => ({ value: item.id, label: item.name })),
    [providers],
  );

  // Провайдер по умолчанию — активный, производным значением, а не эффектом:
  // эффект успел бы отрисовать страницу с пустым выбором и запросить паспорт
  // «никого».
  const providerId = chosen || settings?.provider || 'claude';
  const passport = usePortabilityPassport(providerId, level);

  // Цель переноса — ОТДЕЛЬНЫЙ выбор, и по умолчанию его нет: страница отвечает
  // на вопрос «что у меня настроено» и без цели, а подставленная цель значила
  // бы отчёт о переносе, которого никто не заказывал.
  //
  // Выбранное человеком и ДЕЙСТВУЮЩАЯ цель — разные значения: сменив источник,
  // человек оставляет в состоянии цель, которой при новом источнике нет.
  // Действующую считает `usableTarget`, и дальше по экрану идёт только она —
  // список, запрос и таблица обязаны отвечать об одной и той же цели.
  //
  // Выбор помнит браузер зрителя: без памяти цель терялась при перезагрузке и
  // после записи переноса, и три вкладки из пяти встречали пустыми.
  const [picked, setPickedState] = useState(readRememberedTarget);
  const setPicked = (value: string): void => {
    rememberTarget(value);
    setPickedState(value);
  };

  // Развёрнутые виды паспорта. Живут на странице, а не в карточке: уйдя на
  // другую вкладку и вернувшись, человек видит паспорт тем, каким оставил.
  const [openKinds, setOpenKinds] = useState<ReadonlySet<EnvItemKind>>(() => new Set());
  const toggleKind = (kind: EnvItemKind): void => {
    setOpenKinds((prev) => {
      const next = new Set(prev);
      if (next.has(kind)) next.delete(kind);
      else next.add(kind);
      return next;
    });
  };
  const target = usableTarget(
    picked,
    providerId,
    options.map((option) => option.value),
  );
  // Прогноз нужен только вкладке переноса: запомненная цель иначе заказывала
  // отчёт на каждом открытии паспорта, где его никто не видит (F-247).
  const fidelity = useFidelityReport(providerId, activeTab === 'transfer' ? target : '', level);

  /** Цели — все провайдеры, кроме источника: перенос в самого себя не перенос. */
  const targetOptions = useMemo(
    () => [
      { value: '', label: t('portability.targetNone') },
      ...options.filter((option) => option.value !== providerId),
    ],
    [options, providerId, t],
  );

  const targetName = targetOptions.find((option) => option.value === target)?.label ?? target;

  /**
   * Проекты — из РЕЕСТРА панели: сервер принимает идентификатор записи, а не
   * путь, и список обязан быть тем же самым, иначе человек выбрал бы проект,
   * которого маршрут не знает.
   */
  const projectOptions = useMemo(
    () => [
      { value: '', label: t('portability.projectNone') },
      ...(projects ?? []).map((item) => ({ value: item.id, label: item.name })),
    ],
    [projects, t],
  );

  /** Уровень проекта выбран, а проект — нет: спрашивать сервер не о чем. */
  const levelReady = scope === 'global' || Boolean(project);

  const sections = useMemo(() => passportSections(passport.data), [passport.data]);

  // Отказ сервера — не вечный скелет: заголовок с «?» и кнопка повторить.
  if ((settingsFailed || providersFailed) && (!settings || !providers)) {
    return (
      <Stack gap="var(--spacing-md)">
        <PageHeader
          title={t('portability.title')}
          subtitle={t('portability.subtitle')}
          helpTopic="portability"
        />
        <LoadErrorCard
          onRetry={() => {
            void refetchSettings();
            void refetchProviders();
          }}
        />
      </Stack>
    );
  }

  if (!settings || !providers) return <SkeletonList rows={4} />;

  const renderPassport = (): ReactNode => {
    if (!levelReady) return null;
    if (passport.isLoading) return <SkeletonList rows={4} />;
    if (passport.isError) {
      return (
        <LoadErrorCard
          title={t('portability.loadError')}
          text={t('portability.loadErrorText')}
          onRetry={() => {
            void passport.refetch();
          }}
        />
      );
    }
    // Пусто — это ответ, а не ошибка: у человека законно может не быть ничего
    // настроенного, и сказать об этом надо словами, а не пустым экраном.
    if (sections.length === 0) {
      return (
        <EmptyState icon="file" title={t('portability.empty')} text={t('portability.emptyText')} />
      );
    }
    return (
      <Stack gap="var(--spacing-md)">
        {sections.map((section) => (
          <PassportSection
            key={section.kind}
            title={t(kindLabelKey(section.kind), section.kind)}
            items={section.items}
            skipped={section.skipped}
            sectionState={section.state}
            open={openKinds.has(section.kind)}
            onToggle={() => toggleKind(section.kind)}
            bodyId={`portability-kind-${section.kind}`}
          />
        ))}
      </Stack>
    );
  };

  const usesTarget = TARGET_TABS.includes(activeTab);

  /**
   * Вкладка про конкретную цель без выбранной цели — не пустое место, а
   * подсказка, чего не хватает: пустой экран читался бы как «переносить нечего».
   */
  const renderTargetTab = (content: ReactNode): ReactNode => {
    if (!levelReady) return null;
    if (!target) {
      return (
        <EmptyState
          icon="swap"
          title={t('pageTabs.portability.needsTarget')}
          text={t('pageTabs.portability.needsTargetText')}
        />
      );
    }
    return content;
  };

  const tabs = PORTABILITY_TABS.map((id) => ({
    id,
    label: t(`pageTabs.portability.tab.${id}`),
    icon: PORTABILITY_TAB_ICONS[id],
    ...(id === 'passport' && passport.data ? { count: passport.data.items.length } : {}),
  }));

  return (
    <Stack gap="var(--spacing-md)">
      <PageHeader
        title={t('portability.title')}
        subtitle={t('portability.subtitle')}
        helpTopic="portability"
      />

      <PageTabs
        page="portability"
        label={t('pageTabs.portability.tabsLabel')}
        tabs={tabs}
        active={activeTab}
        onSelect={selectTab}
      />

      <PageTabPanel
        page="portability"
        tab={activeTab}
        hint={t(`pageTabs.portability.hint.${activeTab}`)}
      >
        {/* Выбор источника и уровня общий для всех вкладок, кроме незакрытой
            работы: у неё своя цель — активный CLI, и чужие поля над ней читались
            бы как её настройки. Цель переноса видна только там, где о ней речь. */}
        {activeTab !== 'carry' && (
          <PortabilityPicker
            providerId={providerId}
            onProvider={setChosen}
            providerOptions={options}
            showTarget={usesTarget}
            target={target}
            onTarget={setPicked}
            targetOptions={targetOptions}
            scope={scope}
            onScope={setScope}
            project={project}
            onProject={setProject}
            projectOptions={projectOptions}
            levelReady={levelReady}
            passport={activeTab === 'passport' ? passport.data : undefined}
          />
        )}

        {activeTab === 'passport' && renderPassport()}

        {/* Прогноз «что доедет» и сам перенос — одна вкладка: решение о переносе
            принимается после прогноза, а не до него. Ждать отчёт при этом
            незачем — след прошлого переноса и кнопка отмены нужны и тогда, когда
            прогноз не посчитался. */}
        {activeTab === 'transfer' &&
          renderTargetTab(
            <>
              {fidelity.isError && (
                <LoadErrorCard
                  title={t('portability.fidelity.loadError')}
                  text={t('portability.fidelity.loadErrorText')}
                  onRetry={() => {
                    void fidelity.refetch();
                  }}
                />
              )}
              {fidelity.isLoading && <SkeletonList rows={3} />}
              {fidelity.data && <FidelityTable answer={fidelity.data} targetName={targetName} />}
              <TransferSection
                source={providerId}
                target={target}
                targetName={targetName}
                level={level}
              />
            </>,
          )}

        {activeTab === 'subscription' &&
          renderTargetTab(
            <SubscriptionSection
              source={providerId}
              target={target}
              targetName={targetName}
              level={level}
            />,
          )}

        {activeTab === 'probe' &&
          renderTargetTab(<ProbeSection target={target} targetName={targetName} scope={scope} />)}

        {/* Перенос незакрытой работы (П6.1): цель у него своя — АКТИВНЫЙ CLI, и
            раздел называет её сам. Выбор цели переноса среды он не ждёт:
            незакрытые разговоры есть и когда цель не выбрана. */}
        {activeTab === 'carry' && <CarrySection providers={options} />}
      </PageTabPanel>
    </Stack>
  );
}
