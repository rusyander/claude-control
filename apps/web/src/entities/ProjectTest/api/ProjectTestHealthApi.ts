import { useQuery } from '@tanstack/react-query';
import type {
  ProjectTestLintReport,
  ProjectTestQuarantineReport,
  ProjectTestRiskReport,
  ProjectTestTaxonomyPlan,
} from '@agentdeck/contracts';
import { apiClient } from '@shared/api/client';
import { testKeys } from './keys';

/**
 * Здоровье набора: замечания линтера, дубликаты и предложение таксономии.
 *
 * Оба запроса — чтение и только чтение. Правит библиотеку человек, обычным
 * массовым действием: у линтера в замечании названа кнопка, у таксономии —
 * переносы. Второй ветки правки, которая шла бы мимо привычного bulk, в панели
 * нет намеренно.
 *
 * Считается быстро, но не бесплатно — спрашиваем только когда карточку открыли,
 * а не в каждом опросе вида раздела.
 */

export function useTestLint(path: string | undefined, isEnabled = true) {
  return useQuery({
    queryKey: testKeys.lint(path),
    queryFn: async () => {
      const { data } = await apiClient.get<ProjectTestLintReport>('/project-tests/lint', {
        params: { path },
      });
      return data;
    },
    enabled: Boolean(path) && isEnabled,
  });
}

/**
 * Карантин и устаревание.
 *
 * Отдельным запросом от линтера: он ходит в трекер за датами требований и потому
 * медленнее, а карточка обязана нарисоваться, не дожидаясь чужой системы.
 */
export function useTestQuarantine(path: string | undefined, isEnabled = true) {
  return useQuery({
    queryKey: testKeys.quarantine(path),
    queryFn: async () => {
      const { data } = await apiClient.get<ProjectTestQuarantineReport>(
        '/project-tests/quarantine',
        { params: { path } },
      );
      return data;
    },
    enabled: Boolean(path) && isEnabled,
  });
}

/**
 * Риск кейсов: чем гнать, если времени на всё нет.
 *
 * Бюджет («у меня N минут») в запрос НЕ уходит, хотя сервер его умеет: на экране
 * его применяют к видимому отбору — к той сотне кейсов, которую человек уже
 * сузил фильтром, — и лишний поход на сервер на каждое изменение числа минут
 * означал бы очередь запросов там, где считается одно сложение.
 */
export function useTestRisk(path: string | undefined, isEnabled = true) {
  return useQuery({
    queryKey: testKeys.risk(path),
    queryFn: async () => {
      const { data } = await apiClient.get<ProjectTestRiskReport>('/project-tests/risk', {
        params: { path },
      });
      return data;
    },
    enabled: Boolean(path) && isEnabled,
  });
}

export function useTestTaxonomy(path: string | undefined, minCases: number, isEnabled = true) {
  return useQuery({
    queryKey: testKeys.taxonomy(path, minCases),
    queryFn: async () => {
      const { data } = await apiClient.get<ProjectTestTaxonomyPlan>('/project-tests/taxonomy', {
        params: { path, minCases },
      });
      return data;
    },
    enabled: Boolean(path) && isEnabled,
  });
}
