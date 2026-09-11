import { useTranslation } from 'react-i18next';
import {
  platformBudgetAlarming,
  platformBudgetOf,
  platformCardState,
  usePlatforms,
} from '@entities/Platform';
import { StatTile } from './StatTile';

/**
 * Контур на обзоре. Плитки нет, пока контура нет: пустая строка «0 контуров»
 * заняла бы место в сетке и ничего не сказала бы человеку, который про контур
 * ещё не слышал, — знакомство начинается в самом разделе.
 *
 * Исчерпанный бюджет поднимается СЮДА тревожным тоном: узнать о нём в момент
 * отказа посреди работы — худший из возможных вариантов.
 */
export function PlatformTile() {
  const { t } = useTranslation();
  const { data } = usePlatforms();

  if (!data || data.length === 0) return null;

  const enabled = data.filter((item) => item.platform.enabled);
  // Отказ контура (402) и наша оценка, дошедшая до введённой цифры, поднимаются
  // сюда одинаково: разбираться, что из них что, человек будет в карточке, а
  // узнать в момент отказа посреди работы — худший из вариантов.
  const exhausted = data.find((item) => platformBudgetAlarming(platformBudgetOf(item)));

  // Подсказка называет самое важное состояние из тех, что есть: исчерпанный
  // бюджет, потом отклонённый ключ, потом просто «на связи».
  const worst = data.find((item) => platformCardState(item) === 'unauthorized');
  // Подход к бюджету — не тревога, но и не только цвет полосы на другой
  // странице: 85 % обещаны ДО отказа, а узнать о них человек должен там, где
  // смотрит каждый день.
  const nearLimit = data.find((item) => platformBudgetOf(item).nearLimit);
  const first = enabled[0] ?? data[0]!;

  const hint = ((): string => {
    if (exhausted) return t('platform.budgetExceeded');
    if (worst) return t('platform.state.unauthorized');
    if (nearLimit) {
      const budget = platformBudgetOf(nearLimit);
      return t('platform.budgetNearLimit', { percent: Math.round(budget.share * 100) });
    }
    return t(`platform.state.${platformCardState(first)}`);
  })();

  return (
    <StatTile
      icon="plug"
      label={t('nav.platform')}
      value={enabled.length}
      hint={hint}
      {...(exhausted || worst ? { tone: 'danger' as const } : {})}
      to="/platform"
    />
  );
}
