import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Stack } from '@shared/ui/stack';
import { Button } from '@shared/ui/button';
import { useLocalMcp, useLocalMcpActions } from '@entities/LocalModels';
import { localMcpUnmeasured } from '../../model/localMcpRows';
import { LocalMcpPanel } from './LocalMcpPanel';
import type { LocalMcpPickerProps } from './LocalMcpPicker.types';

/**
 * MCP-серверы локального прогона (L4). Облегчённый набор локальной модели снимает все
 * MCP-серверы: замер 14.10 — один GitLab-сервер стоит 15 тыс. токенов из окна в 65 тыс.
 * Поэтому по умолчанию не берётся ни один, а человек выбирает сам, видя цену каждого
 * и остаток окна на разговор. Выбор помнится по проекту.
 *
 * Список читается при открытии, не при показе чата: файлы настроек и замер незачем
 * дёргать на каждое открытие разговора.
 */
export function LocalMcpPicker({ project, picked }: LocalMcpPickerProps) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const info = useLocalMcp(project, { enabled: open });
  const { pick, measure } = useLocalMcpActions(project);
  const measured = useRef(false);
  const data = info.data;

  // Цены, которых нет, замеряются один раз за открытие: человек выбирает по цифре.
  useEffect(() => {
    if (!open || measured.current || !data) return;
    if (localMcpUnmeasured(data).length === 0) return;
    measured.current = true;
    measure.mutate(undefined);
  }, [open, data, measure]);

  return (
    <Stack gap="var(--spacing-3xs)">
      <Button
        size="sm"
        variant="ghost"
        aria-expanded={open}
        title={t('chat.localMcp.hint')}
        onClick={() => {
          measured.current = false;
          setOpen((value) => !value);
        }}
      >
        {t('chat.localMcp.button', { count: data ? data.picked.length : picked.length })}
      </Button>

      {open && (
        <LocalMcpPanel
          data={data}
          loadFailed={info.isError}
          saving={pick.isPending}
          measuring={measure.isPending}
          onToggle={(id, on) => {
            if (!data) return;
            pick.mutate(on ? [...data.picked, id] : data.picked.filter((item) => item !== id));
          }}
          onRemeasure={(ids) => measure.mutate(ids)}
        />
      )}
    </Stack>
  );
}
