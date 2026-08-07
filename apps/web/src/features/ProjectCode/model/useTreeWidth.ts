import { useEffect, useRef, useState } from 'react';
import {
  PROJECT_CODE_TREE_DEFAULT,
  PROJECT_CODE_TREE_MAX,
  PROJECT_CODE_TREE_MIN,
  clampTreeWidth,
} from '@claude-control/contracts/project-code';
import { useProjectCodeLayout, useSaveProjectCodeLayout } from '@entities/ProjectFile';

export interface TreeWidthApi {
  width: number;
  setWidth: (width: number) => void;
  min: number;
  max: number;
}

/**
 * Ширина списка файлов и память о ней.
 *
 * Память ОБЩАЯ на панель, а не на проект: ширину человек подбирает под себя и
 * под свой экран, и получить в соседнем проекте чужую было бы неожиданностью.
 * Лежит там же, где снимки табов, — в состоянии панели на сервере, поэтому
 * переживает и чистку кэша браузера, и другой браузер.
 *
 * Запись отложенная: перетаскивание даёт событие на каждый пиксель движения, и
 * слать запрос на каждое — сотни запросов за один жест.
 */
export function useTreeWidth(isOpen: boolean): TreeWidthApi {
  const stored = useProjectCodeLayout(isOpen);
  const save = useSaveProjectCodeLayout().mutate;

  const [width, setWidth] = useState(PROJECT_CODE_TREE_DEFAULT);
  const isHydrated = useRef(false);

  // Приехавшую ширину принимаем один раз: дальше источник истины — то, что
  // человек тащит, и повторный ответ запроса не должен возвращать её назад.
  useEffect(() => {
    if (!isOpen || isHydrated.current || !stored.isFetched) return;
    isHydrated.current = true;
    if (stored.data) setWidth(clampTreeWidth(stored.data.treeWidth));
  }, [isOpen, stored.isFetched, stored.data]);

  useEffect(() => {
    if (!isOpen) isHydrated.current = false;
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen || !isHydrated.current) return undefined;

    const timer = window.setTimeout(() => save({ treeWidth: width }), 400);
    return () => window.clearTimeout(timer);
  }, [isOpen, width, save]);

  return { width, setWidth, min: PROJECT_CODE_TREE_MIN, max: PROJECT_CODE_TREE_MAX };
}
