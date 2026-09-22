import { useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import type { EnvItem, EnvItemKind, EnvSkip } from '@agentdeck/contracts/portable-env';
import { Stack } from '@shared/ui/stack';
import { Card } from '@shared/ui/card';
import { Badge } from '@shared/ui/badge';
import { PageHeader } from '@shared/ui/page-header';
import { SelectField } from '@shared/ui/select-field';
import { SkeletonList } from '@shared/ui/skeleton';
import { LoadErrorCard } from '@shared/ui/load-error';
import { EmptyState } from '@shared/ui/empty-state';
import { Typography } from '@shared/ui/typography';
import { useSettings } from '@entities/AppConfig';
import { useProviders } from '@entities/Provider';
import { useProjectRegistry } from '@entities/Project';
import {
  usePortabilityPassport,
  useFidelityReport,
  KIND_ORDER,
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
import styles from './PortabilityPage.module.scss';

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
  const [picked, setPicked] = useState('');
  const target = usableTarget(
    picked,
    providerId,
    options.map((option) => option.value),
  );
  const fidelity = useFidelityReport(providerId, target, level);

  /** Цели — все провайдеры, кроме источника: перенос в самого себя не перенос. */
  const targetOptions = useMemo(
    () => [
      { value: '', label: t('portability.targetNone') },
      ...options.filter((option) => option.value !== providerId),
    ],
    [options, providerId, t],
  );

  const targetName = targetOptions.find((option) => option.value === target)?.label ?? target;

  /** Уровни — ровно два; третьего у канона нет. */
  const scopeOptions = [
    { value: 'global', label: t('portability.scopeGlobal') },
    { value: 'project', label: t('portability.scopeProject') },
  ];

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

  /** Записи по видам в порядке `KIND_ORDER`; вид без записей секции не рисует. */
  const sections = useMemo(() => {
    const items = passport.data?.items ?? [];
    const skipped = passport.data?.skipped ?? [];

    const byKind = new Map<EnvItemKind, EnvItem[]>();
    for (const item of items) {
      const list = byKind.get(item.kind);
      if (list) list.push(item);
      else byKind.set(item.kind, [item]);
    }

    const skipsByKind = new Map<EnvItemKind, EnvSkip[]>();
    for (const skip of skipped) {
      const list = skipsByKind.get(skip.kind);
      if (list) list.push(skip);
      else skipsByKind.set(skip.kind, [skip]);
    }

    // Вид, которого нет в порядке показа, всё равно попадает на экран — хвостом
    // за известными. Потерять его значило бы показать среду без него.
    const known = new Set<EnvItemKind>(KIND_ORDER);
    const tail = [...byKind.keys(), ...skipsByKind.keys()].filter((kind) => !known.has(kind));

    // Рубильник раздела: состояние источника, а не запись. Ищется по виду —
    // список короткий и почти всегда пуст.
    const states = passport.data?.sectionStates ?? [];

    return [...KIND_ORDER, ...new Set(tail)]
      .map((kind) => ({
        kind,
        items: byKind.get(kind) ?? [],
        skipped: skipsByKind.get(kind) ?? [],
        state: states.find((candidate) => candidate.kind === kind),
      }))
      .filter((section) => section.items.length > 0 || section.skipped.length > 0);
  }, [passport.data]);

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
          />
        ))}
      </Stack>
    );
  };

  return (
    <Stack gap="var(--spacing-md)">
      <PageHeader
        title={t('portability.title')}
        subtitle={t('portability.subtitle')}
        helpTopic="portability"
      />

      <Card padding="md">
        <Stack gap="var(--spacing-sm)">
          <Stack direction="row" gap="var(--spacing-sm)" align="end" className={styles.picker}>
            <SelectField
              label={t('portability.provider')}
              value={providerId}
              onChange={setChosen}
              options={options}
            />
            <SelectField
              label={t('portability.target')}
              value={target}
              onChange={setPicked}
              options={targetOptions}
            />
            <SelectField
              label={t('portability.scope')}
              value={scope}
              onChange={(value) => setScope(value === 'project' ? 'project' : 'global')}
              options={scopeOptions}
            />
            {scope === 'project' && (
              <SelectField
                label={t('portability.project')}
                value={project}
                onChange={setProject}
                options={projectOptions}
              />
            )}
          </Stack>

          {/* Уровень проекта без проекта — не пустой экран молча: сказано, чего
              не хватает, иначе человек читает отсутствие паспорта как «в этом
              проекте ничего не настроено». */}
          {!levelReady && (
            <Typography variant="caption" color="muted">
              {t('portability.projectNeeded')}
            </Typography>
          )}

          {passport.data && (
            <Stack direction="row" gap="var(--spacing-xs)" className={styles.summary}>
              <Badge tone="accent">
                {t('portability.itemCount', { count: passport.data.items.length })}
              </Badge>
              {/* Цвет несёт только непрочитанное: пустой раздел — законная
                  часть обычного дома, и красить из-за него весь паспорт значило
                  бы приучить к предупреждению, которое ничего не значит. */}
              <Badge
                tone={
                  passport.data.skipped.some((skip) => skip.reason !== 'empty')
                    ? 'warning'
                    : 'neutral'
                }
              >
                {t('portability.skipCount', { count: passport.data.skipped.length })}
              </Badge>
              {/* Корень паспорта — тот самый каталог, из которого всё прочитано;
                  без него человек не знает, чью среду он видит. */}
              <Typography variant="caption" color="muted" className={styles.root}>
                {passport.data.root || t('portability.rootUnknown')}
              </Typography>
            </Stack>
          )}
        </Stack>
      </Card>

      {/* Отчёт верности стоит НАД паспортом: выбрав цель, человек спрашивает
          «что доедет», и ответ на этот вопрос не должен лежать под списком из
          двух сотен записей. */}
      {target && levelReady && fidelity.isError && (
        <LoadErrorCard
          title={t('portability.fidelity.loadError')}
          text={t('portability.fidelity.loadErrorText')}
          onRetry={() => {
            void fidelity.refetch();
          }}
        />
      )}
      {target && levelReady && fidelity.isLoading && <SkeletonList rows={3} />}
      {target && levelReady && fidelity.data && (
        <FidelityTable answer={fidelity.data} targetName={targetName} />
      )}

      {/* Перенос — под отчётом верности и над паспортом: решение принимается
          после прогноза «что доедет», а не до него. Ждать отчёт при этом
          незачем — след прошлого переноса и кнопка отмены нужны человеку, даже
          когда прогноз не посчитался. */}
      {target && levelReady && (
        <TransferSection
          source={providerId}
          target={target}
          targetName={targetName}
          level={level}
        />
      )}

      {/* Подписка — ПОД разовым переносом: сначала человек учится переносить
          один раз и видит, что из этого выходит, и только потом решает, держать
          ли цель согласованной дальше. Порядок здесь — порядок разговора, а не
          порядок появления тикетов. */}
      {target && levelReady && (
        <SubscriptionSection
          source={providerId}
          target={target}
          targetName={targetName}
          level={level}
        />
      )}

      {/* Перенос незакрытой работы (П6.1) — ПОД переносом среды и подпиской, и
          цели у них разные: среда едет в выбранную цель, работа — к АКТИВНОМУ
          CLI. Раздел называет свою цель сам и не зависит от выбора выше, чтобы
          эта разница не читалась как одно и то же решение. Цели переноса среды
          он не ждёт: незакрытые разговоры есть и когда цель не выбрана. */}
      <CarrySection providers={options} />

      {/* Проба — ПОД переносом: она отвечает на вопрос «а доехало ли на самом
          деле», который возникает после применения. Стоять над ним она не может
          и по смыслу: до переноса сверять с прогнозом нечего. */}
      {target && levelReady && (
        <ProbeSection target={target} targetName={targetName} scope={scope} />
      )}

      {renderPassport()}
    </Stack>
  );
}
