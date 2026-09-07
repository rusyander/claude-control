import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  assignableEffortsUpTo,
  assignableModelsUpTo,
  clampAssignment,
  manualAssignment,
  modelAlias,
  type CascadeAssignment,
} from '@agentdeck/contracts/model-cascade';
import { Modal } from '@shared/ui/modal';
import { Stack } from '@shared/ui/stack';
import { Typography } from '@shared/ui/typography';
import { Button } from '@shared/ui/button';
import { Icon } from '@shared/ui/icon';
import { Toggle } from '@shared/ui/toggle';
import { TextField } from '@shared/ui/text-field';
import { normalizeProjectPath } from '@shared/lib/workspace';
import type { ParallelLaunchProps } from './ParallelLaunch.types';
import styles from './ParallelLaunch.module.scss';

/**
 * С какого числа агентов на потолке запуск считается дорогим и получает
 * предупреждение. Два прогона — обычная работа; на третьем веер начинает
 * заметно съедать окно лимитов, и человек имеет право узнать об этом ДО нажатия,
 * а не из упёршегося в лимит агента.
 */
const CEILING_WARN_FROM = 3;

/**
 * Запуск одного запроса сразу в нескольких проектах. Отмечаешь проекты, пишешь
 * одну задачу — в каждом стартует свой агент. За ними потом видно из пульта и по
 * цветным точкам на табах. Правки по умолчанию разрешены — как и в обычном чате
 * (`chatPrefsStore`): агент, которому нельзя писать, в проекте бесполезен, а
 * выключить тумблер перед запуском можно тут же.
 *
 * Модель выбирается ЗДЕСЬ, а не только в шапке чата, и это главное отличие веера
 * от обычной отправки. Пять агентов, стартующих разом на потолке, съедают окно
 * лимитов быстрее всего, что вообще делает панель, — а работа у веера чаще всего
 * одинаковая и понятная («прогони линт», «обнови зависимость»). Ступень ниже
 * потолка выбирается одна на весь запуск: разные модели по проектам значили бы
 * разный результат на одинаковой задаче.
 *
 * Понижение здесь оплачивается ПЛАНКОЙ СДАЧИ и только ей: конвейер «работа →
 * ревью → правки» живёт на связи разделения и на копии ветки, а веер идёт в
 * настоящих проектах. Об этом сказано и человеку в подсказке, и агенту в задании
 * (`loweredWorkPrompt(…, { review: false })` на сервере).
 */
export function ParallelLaunch({
  isOpen,
  onOpenChange,
  projects,
  ceiling,
  onLaunch,
}: ParallelLaunchProps) {
  const { t } = useTranslation();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [prompt, setPrompt] = useState('');
  const [allowEdits, setAllowEdits] = useState(true);
  // Чего человек хочет от веера по моделям. Пусто — потолок: подбирать род
  // работы здесь не по чему, задание одно на все проекты и класс ему никто не
  // называл, поэтому по умолчанию всё идёт ровно как раньше.
  const [wish, setWish] = useState<CascadeAssignment | undefined>(undefined);

  // При каждом открытии — с чистого листа.
  useEffect(() => {
    if (isOpen) {
      setSelected(new Set());
      setPrompt('');
      setAllowEdits(true);
      setWish(undefined);
    }
  }, [isOpen]);

  // Запускать можно только в существующих на диске проектах.
  const available = useMemo(() => projects.filter((project) => project.exists), [projects]);

  const toggle = (id: string): void => {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const chosen = available.filter((project) => selected.has(normalizeProjectPath(project.path)));
  const canLaunch = chosen.length > 0 && prompt.trim().length > 0;

  // Что вообще можно назначить при этом потолке — тот же список, что и на
  // карточке разделения. Пусто = потолок не распознан, и выбора не показываем
  // вовсе: обещать ступени, которых панель не умеет сравнивать, нельзя.
  const models = ceiling ? assignableModelsUpTo(ceiling.model) : [];
  const efforts = ceiling ? assignableEffortsUpTo(ceiling.effort) : [];
  // Потолок без глубины («как решит CLI») — законное значение, и в списке оно
  // должно быть: иначе select показывал бы первый пункт вместо того, что уедет.
  const effortOptions =
    ceiling && clampAssignment({}, ceiling).effort === '' ? ['', ...efforts] : efforts;
  const hasCascade = Boolean(ceiling) && models.length > 0;
  // Выбор человека действует в обе стороны и держится потолком — тот же
  // `manualAssignment`, что и на карточке; он же считает `lowered`.
  const plan = hasCascade && ceiling ? manualAssignment(wish ?? {}, ceiling) : undefined;

  // Замена всегда содержит ОБЕ оси: поменяв модель, человек не просил сбросить
  // глубину, а неполное пожелание сервер добрал бы с потолка.
  const replace = (patch: CascadeAssignment): void =>
    setWish({ model: modelAlias(plan?.model ?? '') ?? '', effort: plan?.effort ?? '', ...patch });

  return (
    <Modal
      isOpen={isOpen}
      onOpenChange={onOpenChange}
      title={t('parallel.title')}
      description={t('parallel.hint')}
      size="md"
      footer={
        <Stack
          direction="row"
          justify="between"
          align="center"
          gap="var(--spacing-sm)"
          width="100%"
        >
          <Stack
            as="label"
            direction="row"
            align="center"
            gap="var(--spacing-2xs)"
            className={styles.editsToggle}
          >
            <Toggle
              size="sm"
              checked={allowEdits}
              onCheckedChange={setAllowEdits}
              aria-label={t('chat.allowEdits')}
            />
            <Typography variant="caption" color={allowEdits ? 'default' : 'subtle'} as="span">
              {allowEdits ? t('chat.editsAllowed') : t('chat.readOnly')}
            </Typography>
          </Stack>
          <Stack direction="row" gap="var(--spacing-xs)">
            <Button variant="ghost" onClick={() => onOpenChange(false)}>
              {t('common.cancel')}
            </Button>
            <Button
              variant="primary"
              disabled={!canLaunch}
              leftIcon={<Icon name="send" size={20} />}
              onClick={() =>
                onLaunch(
                  chosen,
                  prompt.trim(),
                  allowEdits,
                  plan
                    ? { model: plan.model, effort: plan.effort, lowered: plan.lowered }
                    : undefined,
                )
              }
            >
              {t('parallel.launch', { count: chosen.length })}
            </Button>
          </Stack>
        </Stack>
      }
    >
      <Stack gap="var(--spacing-sm)">
        <TextField
          label={t('parallel.prompt')}
          value={prompt}
          onChange={setPrompt}
          placeholder={t('parallel.promptPlaceholder')}
          multiline
          rows={3}
        />

        {/* Модель веера — рядом с заданием, а не в шапке чата: решение про неё
            принимают, глядя на то, СКОЛЬКО агентов сейчас стартует. */}
        {hasCascade && plan && (
          <Stack direction="row" align="center" gap="var(--spacing-2xs)" wrap>
            <Typography variant="caption" color="subtle" as="span">
              {t('parallel.cascade.label')}
            </Typography>
            {/* Нативные select — как в шапке чата и на карточке разделения:
                компактно и правильно работают с клавиатурой и дикторами. */}
            <select
              className={styles.select}
              value={modelAlias(plan.model) ?? ''}
              onChange={(event) => replace({ model: event.target.value })}
              aria-label={t('parallel.cascade.model')}
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
              onChange={(event) => replace({ effort: event.target.value })}
              aria-label={t('parallel.cascade.effort')}
            >
              {effortOptions.map((level) => (
                <option key={level || 'default'} value={level}>
                  {level ? t(`chat.effort_${level}`) : t('chat.effortAuto')}
                </option>
              ))}
            </select>
            {plan.lowered && (
              <span className={styles.lowered} title={t('parallel.cascade.loweredHint')}>
                {t('chat.split.cascade.lowered')}
              </span>
            )}
          </Stack>
        )}

        {/* Цена решения — рядом с самим решением. Кнопка внизу говорит, СКОЛЬКО
            агентов стартует, но не говорит, что стартовать их разом на потолке
            дороже всего, что панель делает. Порог — три: два прогона это
            обычная работа, а с третьего запуск начинает заметно съедать окно
            лимитов. Только при доступном подборе: без него совет «возьми
            ступень ниже» некуда исполнить. */}
        {hasCascade && plan && !plan.lowered && chosen.length >= CEILING_WARN_FROM && (
          <Typography variant="caption" color="warning" role="status">
            {t('parallel.cascade.ceilingWarn', { count: chosen.length })}
          </Typography>
        )}

        <Typography variant="caption" color="subtle">
          {t('parallel.pickProjects', { count: chosen.length })}
        </Typography>

        <div className={styles.list}>
          {available.map((project) => {
            const id = normalizeProjectPath(project.path);
            const isOn = selected.has(id);
            return (
              <button
                key={project.path}
                type="button"
                className={`${styles.item} ${isOn ? styles.itemOn : ''}`}
                onClick={() => toggle(id)}
                title={project.path}
              >
                <span className={styles.check}>{isOn && <Icon name="check" size={14} />}</span>
                <Stack gap="0" className={styles.itemText}>
                  <Typography variant="body-sm" as="span" truncate>
                    {project.name}
                  </Typography>
                  <Typography
                    variant="mono"
                    color="subtle"
                    as="span"
                    truncate
                    className={styles.path}
                  >
                    {project.path}
                  </Typography>
                </Stack>
              </button>
            );
          })}
        </div>
      </Stack>
    </Modal>
  );
}
