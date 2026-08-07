import { useEffect, useRef, useState } from 'react';
import { useProjectCodeView, useSaveProjectCodeView } from '@entities/ProjectFile';

/**
 * Что открыто в окне кода этого проекта — и память об этом между открытиями.
 *
 * Снимок (открытый файл, раскрытые папки, режимы показа) лежит на сервере, в
 * состоянии панели, а не в localStorage: у каждого таба проекта своё дерево, и
 * терять его от чистки кэша браузера незачем. Пока таб открыт — снимок живёт;
 * таб закрыли — запись стирается (`useForgetProjectCodeView` в сессии чата).
 *
 * Восстановление одноразовое: пока снимок не приехал, состояние не пишется
 * обратно, иначе пустые умолчания успевали бы затереть сохранённое.
 */
export function useCodeView(
  projectPath: string | undefined,
  isOpen: boolean,
  changedDirs: Set<string>,
) {
  const [selected, setSelected] = useState<string | undefined>(undefined);
  const [openDirs, setOpenDirs] = useState<string[]>([]);
  const [showDiff, setShowDiff] = useState(true);
  const [onlyChanged, setOnlyChanged] = useState(false);
  const [isHydrated, setHydrated] = useState(false);
  const didExpand = useRef(false);

  const stored = useProjectCodeView(isOpen ? projectPath : undefined);
  const remember = useSaveProjectCodeView(projectPath);
  const save = remember.mutate;

  // Ждём именно ЗАВЕРШЕНИЯ запроса, а не его успеха: снимок — удобство, а не
  // условие работы. Сервер на него ответил отказом — окно всё равно обязано
  // открыться, просто с чистого листа.
  useEffect(() => {
    if (!isOpen || isHydrated || !stored.isFetched) return;

    const saved = stored.data;
    if (saved) {
      setSelected(saved.file || undefined);
      setOpenDirs(saved.openDirs);
      setShowDiff(saved.showDiff);
      setOnlyChanged(saved.onlyChanged);
    }
    setHydrated(true);
  }, [isOpen, isHydrated, stored.isFetched, stored.data]);

  // Первое открытие: раскрываем папки, где агент что-то менял. Одноразово и
  // только при отсутствии снимка — иначе свёрнутая руками папка раскрывалась бы
  // обратно на каждом обновлении сводки правок.
  useEffect(() => {
    if (!isOpen || !isHydrated || didExpand.current) return;
    if (stored.data) {
      didExpand.current = true;
      return;
    }
    if (changedDirs.size === 0) return;

    didExpand.current = true;
    setOpenDirs((current) => [...new Set([...current, ...changedDirs])]);
  }, [isOpen, isHydrated, stored.data, changedDirs]);

  // Запись с задержкой: раскрытие дерева идёт щелчками подряд, и слать запрос
  // на каждый — платить сетью за промежуточные состояния, которых никто не
  // увидит.
  useEffect(() => {
    if (!isOpen || !isHydrated || !projectPath) return undefined;

    const timer = window.setTimeout(() => {
      save({ file: selected, openDirs, showDiff, onlyChanged });
    }, 400);
    return () => window.clearTimeout(timer);
  }, [isOpen, isHydrated, projectPath, selected, openDirs, showDiff, onlyChanged, save]);

  // Закрыли окно — состояние обнуляется, но снимок на сервере остаётся: он
  // переживает закрытие окна и умирает вместе с табом.
  useEffect(() => {
    if (isOpen) return;
    setSelected(undefined);
    setOpenDirs([]);
    setShowDiff(true);
    setOnlyChanged(false);
    setHydrated(false);
    didExpand.current = false;
  }, [isOpen]);

  const toggleDir = (path: string): void => {
    setOpenDirs((current) =>
      current.includes(path) ? current.filter((dir) => dir !== path) : [...current, path],
    );
  };

  return {
    selected,
    select: setSelected,
    openDirs,
    toggleDir,
    showDiff,
    setShowDiff,
    onlyChanged,
    setOnlyChanged,
    isHydrated,
  };
}
