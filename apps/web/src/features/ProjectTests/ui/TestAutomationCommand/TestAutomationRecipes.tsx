import { useTranslation } from 'react-i18next';
import type { ProjectTestAutomationRecipe } from '@agentdeck/contracts';
import { Stack } from '@shared/ui/stack';
import { Button } from '@shared/ui/button';
import { Typography } from '@shared/ui/typography';
import type { TestAutomationRecipesProps } from './TestAutomationCommand.types';
import styles from './TestAutomationCommand.module.scss';

/**
 * Готовые команды, найденные по файлам проекта: стек, каталог, по какому файлу
 * узнан, сколько тестов. Нехватку программы рецепт называет ДО прогона —
 * иначе человек узнал бы о ней из пустого отчёта и хвоста вывода.
 */
export function TestAutomationRecipes({ recipes, disabled, onTake }: TestAutomationRecipesProps) {
  const { t } = useTranslation();
  /** Где гонит рецепт: все модули, каталог модуля или корень. */
  const recipeDir = (recipe: ProjectTestAutomationRecipe): string => {
    if (recipe.id.endsWith(':*')) {
      return t('testsE2e.automation.allModules', { count: recipe.evidence.length });
    }
    return recipe.dir ? `${recipe.dir}/` : t('testsE2e.automation.root');
  };

  return (
    <ul className={styles.recipes} data-testid="tests-automation-recipes">
      {recipes.map((recipe) => (
        <li key={recipe.id} className={styles.recipe}>
          <Stack gap="var(--spacing-3xs)" className={styles.recipeText}>
            <Typography variant="caption" weight="medium" as="span">
              {t('testsE2e.automation.recipe', {
                stack: t(`testsE2e.automation.stack.${recipe.stack}`),
                dir: recipeDir(recipe),
              })}
            </Typography>
            <code className={styles.command}>{recipe.automation.command}</code>
            <Typography variant="caption" color="subtle" as="span">
              {[
                t('testsE2e.automation.evidence', { files: recipe.evidence.join(', ') }),
                t('testsE2e.automation.tests', { count: recipe.tests }),
                recipe.wholeSuite ? t('testsE2e.automation.wholeSuite') : '',
              ]
                .filter(Boolean)
                .join(' · ')}
            </Typography>
            {recipe.missing && (
              <Typography variant="caption" color="warning" as="span">
                {[
                  t('testsE2e.automation.missing', { tool: recipe.tool }),
                  recipe.install
                    ? t('testsE2e.automation.install', { install: recipe.install })
                    : '',
                ]
                  .filter(Boolean)
                  .join(' ')}
              </Typography>
            )}
          </Stack>
          <Button
            variant="secondary"
            size="sm"
            title={t('testsE2e.automation.takeHint')}
            disabled={disabled}
            onClick={() => onTake(recipe)}
          >
            {t('testsE2e.automation.take')}
          </Button>
        </li>
      ))}
    </ul>
  );
}
