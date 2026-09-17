import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { branchTaken, buildGroupPrompt } from '@agentdeck/contracts/task-split';
import {
  assignableEffortsUpTo,
  assignableModelsUpTo,
  clampAssignment,
  manualAssignment,
  modelAlias,
  planAssignment,
  plannedRunCount,
  type CascadeAssignment,
  type CascadePlan,
} from '@agentdeck/contracts/model-cascade';
import { chooseRunModel } from '@agentdeck/contracts/platform-models';
import { usePlatformRunPlan } from '@entities/Platform';
import { platformModelCaption } from '@shared/lib/chat-model';
import { Stack } from '@shared/ui/stack';
import { Typography } from '@shared/ui/typography';
import { Button } from '@shared/ui/button';
import { Icon } from '@shared/ui/icon';
import { Toggle } from '@shared/ui/toggle';
import type { TaskSplitCardProps } from './TaskSplitCard.types';
import styles from './TaskSplitCard.module.scss';

/**
 * Предложение разделить задачи по нескольким чатам.
 *
 * Приходит блоком в ответе агента, а показывается карточкой: сырой JSON в ленте
 * не читается, а решение здесь принимает человек, и принимать его он должен по
 * составу групп, а не по формату. Поэтому видно ровно то, что важно для выбора,
 * — какие задачи куда уедут и под какой веткой.
 *
 * Кнопки две, и обе — решение, а не подтверждение: «делать здесь по очереди»
 * такой же законный ответ, как и разделение, и уходит агенту обычной репликой.
 * Субагентов не появляется ни в одном из случаев: каждая группа — обычный чат,
 * в котором человек разговаривает сам.
 *
 * Когда в проекте действует подбор модели, у группы видно ещё три вещи: класс
 * работы, модель и глубину. Считает их ТОТ ЖЕ `planAssignment`, что и сервер, по
 * тому же заданию (`buildGroupPrompt`), — иначе карточка обещала бы одно, а
 * стартовало другое. Поменять можно до запуска, и выбор человека действует в обе
 * стороны, включая `haiku`, которого подбор не назначает никогда сам.
 */
export function TaskSplitCard({
  proposal,
  ceiling,
  onSplit,
  onKeepHere,
  isPending,
  disabled,
  childBranches,
}: TaskSplitCardProps) {
  const { t } = useTranslation();
  // «Только завести чаты» — для случая, когда сначала хочется прочитать задания
  // и поправить их, а не получить четырёх агентов, стартовавших разом.
  const [createOnly, setCreateOnly] = useState(false);
  // Замены человека по номеру группы. Живут в карточке до нажатия и уезжают
  // отдельным полем запроса: подмешать их в предложение агента нельзя — его
  // просьба действует только вверх, а выбор человека в обе стороны.
  const [assignments, setAssignments] = useState<Record<number, CascadeAssignment>>({});

  const count = proposal.groups.length;
  const isLocked = Boolean(isPending || disabled);

  // Что вообще можно назначить при этом потолке. Пусто — потолок не распознан
  // (чужой вендор, незнакомое имя), и подбора нет ни здесь, ни на сервере.
  const models = ceiling ? assignableModelsUpTo(ceiling.model) : [];
  const efforts = ceiling ? assignableEffortsUpTo(ceiling.effort) : [];
  // Потолок без глубины («как решит CLI») — законное значение, и в списке оно
  // должно быть: иначе select показывал бы первый пункт вместо того, что уедет.
  const effortOptions =
    ceiling && clampAssignment({}, ceiling).effort === '' ? ['', ...efforts] : efforts;
  const hasCascade = Boolean(ceiling) && models.length > 0;

  // Группы разделения — свой потребитель контура. Через контур модель группы —
  // просьба, а не решение: имя переводится картой или заменяется моделью
  // контура, и сказать это надо под тем выбором, где человек её меняет, а не
  // только в шапке чата (ревью Т6, m10). Считает та же `chooseRunModel`, что и
  // сервер. Без подбора модели выбора нет — и спрашивать план незачем.
  const runPlan = usePlatformRunPlan(hasCascade ? 'groups' : '');
  const routed = runPlan.data?.routed === true ? runPlan.data : undefined;

  // Чем пойдёт каждая группа. Класс распознаётся подбором один раз и переживает
  // ручную замену: по нему группа подписана, и менять модель — не значит менять
  // род работы.
  const plans: CascadePlan[] =
    hasCascade && ceiling
      ? proposal.groups.map((group, index) => {
          const auto = planAssignment(
            {
              ...(group.kind ? { kind: group.kind } : {}),
              ...(group.model ? { model: group.model } : {}),
              ...(group.effort ? { effort: group.effort } : {}),
              tasks: group.tasks.length,
              // Длина ЗАДАНИЯ, а не списка задач: по ней подбор поднимает ранг
              // большой группы, и считать её надо ровно тем же сборщиком, каким
              // сервер соберёт задание для чата.
              length: buildGroupPrompt(group, proposal.shared).length,
            },
            ceiling,
          );
          const wish = assignments[index];
          return wish ? manualAssignment(wish, ceiling, auto.kind) : auto;
        })
      : [];

  // Замена всегда содержит ОБЕ оси: поменяв модель, человек не просил сбросить
  // подобранную глубину, а неполное пожелание сервер добрал бы с потолка.
  const replace = (index: number, patch: CascadeAssignment): void => {
    const plan = plans[index];
    setAssignments((prev) => ({
      ...prev,
      [index]: {
        model: modelAlias(plan?.model ?? '') ?? '',
        effort: plan?.effort ?? '',
        ...patch,
      },
    }));
  };

  // Сколько групп поедет слабее потолка: им дописывается планка сдачи, и знать
  // об этом человек должен ДО кнопки, а не по факту.
  const lowered = plans.filter((plan) => plan.lowered).length;

  // Сколько групп уже стали чатами. Считаем по веткам, а не по названиям: имя
  // ветки — единственное, что переживает и заведение копии, и перезагрузку
  // страницы, и переход с телефона.
  const done = childBranches?.length
    ? proposal.groups.filter((group) => branchTaken(group.branch, childBranches)).length
    : 0;
  // Хотя бы одна группа заведена — предложение отработано. Именно «хотя бы
  // одна», а не «все»: при частичном сбое (три ветки из четырёх) повтор завёл
  // бы три удавшиеся заново, вторыми копиями, а четвёртую — снова уронил.
  const isDone = done > 0;

  return (
    <div className={styles.card} data-split-card>
      <Stack direction="row" align="center" gap="var(--spacing-2xs)" className={styles.head}>
        <Icon name="branch" size={18} />
        <Typography variant="body-sm" weight="medium" as="span">
          {t('chat.split.title', { count })}
        </Typography>
      </Stack>

      {proposal.shared && (
        <Typography variant="body-sm" color="muted" className={styles.shared}>
          {proposal.shared}
        </Typography>
      )}

      <Stack gap="var(--spacing-xs)" className={styles.groups}>
        {/* Ключ по номеру, а не по ветке: разбор предложения имена веток не
            разуникаливает (это делает git, уже при заведении копии), и модель
            вполне может назвать две группы одинаково. */}
        {proposal.groups.map((group, index) => {
          const plan = plans[index];
          const contourCaption =
            routed && plan
              ? platformModelCaption(routed.title, chooseRunModel(routed.rules, plan.model))
              : undefined;
          return (
            <div key={index} className={styles.group}>
              <Stack direction="row" align="center" gap="var(--spacing-2xs)" wrap>
                <Typography variant="body-sm" weight="medium" as="span">
                  {group.title}
                </Typography>
                <span className={styles.branch}>{group.branch}</span>
              </Stack>
              {/* Ревью-группа названа заголовком MR, а заголовки повторяются:
                  решают тут по самому запросу на слияние, поэтому ссылка видна
                  целиком и до кнопки, а не после заведения чата. */}
              {group.review && (
                <a
                  className={styles.reviewLink}
                  href={group.review.url}
                  target="_blank"
                  rel="noreferrer noopener"
                >
                  {group.review.url}
                </a>
              )}
              {/* Единственный пункт, дословно повторяющий заголовок, — это разбор
                  подставил название вместо списка, которого модель не прислала.
                  Печатать его второй раз незачем: строка та же самая. */}
              {(group.tasks.length > 1 || group.tasks[0] !== group.title) && (
                <ul className={styles.tasks}>
                  {group.tasks.map((task, position) => (
                    <li key={position}>{task}</li>
                  ))}
                </ul>
              )}
              {plan && (
                <Stack
                  direction="row"
                  align="center"
                  gap="var(--spacing-3xs)"
                  wrap
                  className={styles.assign}
                >
                  <span className={styles.kind}>
                    {plan.kind
                      ? t(`chat.split.cascade.kind.${plan.kind}`)
                      : t('chat.split.cascade.kindUnknown')}
                  </span>
                  {/* Нативные select — как в шапке чата: компактно, правильно
                      работают с клавиатурой и дикторами, чинить их не надо. */}
                  <select
                    className={styles.select}
                    value={modelAlias(plan.model) ?? ''}
                    onChange={(event) => replace(index, { model: event.target.value })}
                    disabled={isLocked || !onSplit || isDone}
                    aria-label={t('chat.split.cascade.model', { title: group.title })}
                  >
                    {models.map((model) => (
                      <option key={model} value={model}>
                        {model}
                      </option>
                    ))}
                  </select>
                  <select
                    className={styles.select}
                    value={plan.effort}
                    onChange={(event) => replace(index, { effort: event.target.value })}
                    disabled={isLocked || !onSplit || isDone}
                    aria-label={t('chat.split.cascade.effort', { title: group.title })}
                  >
                    {effortOptions.map((level) => (
                      <option key={level || 'default'} value={level}>
                        {level ? t(`chat.effort_${level}`) : t('chat.effortAuto')}
                      </option>
                    ))}
                  </select>
                  {plan.lowered && (
                    <span className={styles.lowered} title={t('chat.split.cascade.loweredHint')}>
                      {t('chat.split.cascade.lowered')}
                    </span>
                  )}
                  {/* Живой областью, как в шапке: подпись меняется от выбора
                      модели рядом, и диктор иначе о подмене не узнал бы. */}
                  {contourCaption && (
                    <Typography
                      variant="caption"
                      color={contourCaption.warn ? 'warning' : 'muted'}
                      as="span"
                      role="status"
                      aria-live="polite"
                    >
                      {t(contourCaption.key, contourCaption.params)}
                    </Typography>
                  )}
                </Stack>
              )}
            </div>
          );
        })}
      </Stack>

      {/* Глубину контур не принимает — одной строкой на всю карточку, а не у
          каждой группы: выбор глубины у групп остаётся, но наверх не уедет. */}
      {hasCascade && routed && !routed.effort && (
        <Typography variant="caption" color="muted" as="p">
          {t('chat.platformNoEffort', { title: routed.title })}
        </Typography>
      )}

      {/* Предложение уже отработано: вместо кнопок — итог. Карточка остаётся на
          месте (по ней читают, что и куда уехало), но заводить по ней второй раз
          нечего, а молча погашенная кнопка выглядела бы поломкой. */}
      {isDone && (
        <Stack direction="row" align="center" gap="var(--spacing-2xs)" className={styles.option}>
          <Icon name="check" size={18} />
          <Typography variant="body-sm" color="muted" as="span">
            {t('chat.split.alreadyDone', { done, count })}
          </Typography>
        </Stack>
      )}

      {onSplit && !isDone && (
        <Stack direction="row" align="center" gap="var(--spacing-2xs)" className={styles.option}>
          <Toggle
            size="sm"
            checked={createOnly}
            onCheckedChange={setCreateOnly}
            disabled={isLocked}
            aria-label={t('chat.split.createOnly')}
          />
          <Typography variant="body-sm" color="muted" as="span">
            {t('chat.split.createOnly')}
          </Typography>
        </Stack>
      )}

      {/* Цена решения ДО кнопки: сколько заведётся чатов и сколько прогонов
          стартует прямо сейчас. Окно запросов тратят именно прогоны, и «только
          завести чаты» честно показывает здесь ноль. */}
      {hasCascade && onSplit && !isDone && (
        <Typography variant="caption" color="subtle" className={styles.cost}>
          {t('chat.split.cascade.cost', { chats: count, runs: createOnly ? 0 : count })}
          {lowered > 0 && ` · ${t('chat.split.cascade.loweredCount', { count: lowered })}`}
          {/* Конвейер добавляет прогоны, а не агентов: разбор на всё разделение,
              план у каждой группы, а у понижённой за работой ещё ревью и правки по
              его замечаниям — последовательно в той же копии. Называем это ДО
              кнопки: столько панель заведёт сама. «Только завести чаты» уровней
              не получает, там счёт прежний. */}
          {(lowered > 0 || !createOnly) &&
            ` · ${t(
              createOnly ? 'chat.split.cascade.pipeline' : 'chat.split.cascade.pipelinePlanned',
              {
                total: plannedRunCount(plans, { planned: !createOnly }),
              },
            )}`}
        </Typography>
      )}

      {onSplit && !isDone && (
        <Stack direction="row" gap="var(--spacing-2xs)" wrap className={styles.actions}>
          <Button
            variant="primary"
            leftIcon={<Icon name="branch" size={18} />}
            onClick={() =>
              onSplit({
                startRuns: !createOnly,
                ...(Object.keys(assignments).length > 0 ? { assignments } : {}),
              })
            }
            isLoading={isPending}
            disabled={isLocked}
          >
            {t('chat.split.apply', { count })}
          </Button>
          {onKeepHere && (
            <Button variant="secondary" onClick={onKeepHere} disabled={isLocked}>
              {t('chat.split.keepHere')}
            </Button>
          )}
        </Stack>
      )}
    </div>
  );
}
