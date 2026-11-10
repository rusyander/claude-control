import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import axios from 'axios';
import type { PickPayload, SitePreview } from '@agentdeck/contracts/site-preview';
import { apiClient } from '@shared/api/client';
import { toErrorMessage } from '@shared/api/toErrorMessage';
import { toast } from '@shared/lib/toast';
import { useProjectRuns } from '@entities/ProjectRunner';
import type { ProjectRunnerView } from '@agentdeck/contracts';
import type { SitePreviewState } from './useSitePreview.types';

/**
 * Цель, чей сайт можно открыть: работает и назвала адрес. Корень проекта — первым: он и есть
 * «сайт проекта», подпапки (бэкенд, документация) — следом в порядке списка реестра.
 */
export function siteTarget(runs: ProjectRunnerView[]): ProjectRunnerView | undefined {
  const live = runs.filter((run) => run.status === 'running' && run.url && run.port);
  return live.find((run) => run.dir === '') ?? live[0];
}

/** Код отказа сервера окна сайта (`{code}`): текст ему даёт словарь, не сервер. */
function refusalCode(error: unknown): string | undefined {
  if (!axios.isAxiosError(error)) return undefined;
  const code = (error.response?.data as { code?: unknown } | undefined)?.code;
  return typeof code === 'string' ? code : undefined;
}

/** Один запуск цели: тот же путь, порт, адрес и время старта. */
type RunKey = Pick<ProjectRunnerView, 'path' | 'port' | 'url' | 'startedAt'>;

/**
 * Тот же ли это запуск, над которым открыто окно. Перезапуск между двумя опросами реестра
 * сохраняет путь, но меняет порт и время старта — а прокси прежнего запуска сервер уже закрыл:
 * сравнение одного пути оставляло бы мёртвую рамку.
 */
export function sameRun(a: RunKey, b: RunKey): boolean {
  return a.path === b.path && a.port === b.port && a.url === b.url && a.startedAt === b.startedAt;
}

/**
 * Окно сайта проекта в чате (D20). Открыть можно только цель, которую запустила сама панель и
 * которая работает: сервер поднимает над ней свой прокси и даёт `nonce`. Цель остановилась или
 * перезапустилась, проект сменился — окно закрывается: прокси сервера к тому времени уже закрыт
 * реестром; полоса «Сайт:» открывает новый запуск заново.
 */
export function useSitePreview(projectPath: string | undefined): SitePreviewState {
  const { t } = useTranslation();
  const runs = useProjectRuns(projectPath);
  const target = siteTarget(runs);
  const [opened, setOpened] = useState<{ preview: SitePreview; run: RunKey; name: string }>();
  const [isOpening, setOpening] = useState(false);

  const stillRunning = opened !== undefined && target !== undefined && sameRun(target, opened.run);
  useEffect(() => {
    if (opened && !stillRunning) setOpened(undefined);
  }, [opened, stillRunning]);
  useEffect(() => setOpened(undefined), [projectPath]);

  const open = useCallback(async (): Promise<boolean> => {
    if (!target) {
      toast.warning(t('sitePreview.notRunning'));
      return false;
    }
    setOpening(true);
    try {
      const { data } = await apiClient.post<SitePreview>('/site-preview', { path: target.path });
      const { path, port, url, startedAt } = target;
      setOpened({ preview: data, run: { path, port, url, startedAt }, name: target.name });
      return true;
    } catch (error) {
      const code = refusalCode(error);
      toast.error(
        code === 'site-not-running' || code === 'site-not-loopback'
          ? t('sitePreview.notRunning')
          : t('sitePreview.openFailed', { message: toErrorMessage(error) }),
      );
      return false;
    } finally {
      setOpening(false);
    }
  }, [t, target]);

  const close = useCallback(() => setOpened(undefined), []);

  /** Выбор — серверу: он сверяет `nonce`, маскирует секреты в тексте и разметке, правит адрес. */
  const pick = useCallback(
    async (raw: PickPayload): Promise<PickPayload | undefined> => {
      if (!opened) return undefined;
      try {
        const { data } = await apiClient.post<PickPayload>(
          `/site-preview/${encodeURIComponent(opened.preview.siteId)}/pick`,
          raw,
        );
        return data;
      } catch {
        toast.error(t('sitePreview.pickFailed'));
        return undefined;
      }
    },
    [opened, t],
  );

  return useMemo(
    () => ({
      ...(target ? { target } : {}),
      ...(opened && stillRunning
        ? { preview: opened.preview, name: opened.name, siteUrl: target?.url ?? '' }
        : {}),
      isOpening,
      open,
      close,
      pick,
    }),
    [target, opened, stillRunning, isOpening, open, close, pick],
  );
}
