import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { PermissionDecision, PermissionDraft } from '@claude-control/contracts';
import { Stack } from '@shared/ui/stack';
import { Modal } from '@shared/ui/modal';
import { Button } from '@shared/ui/button';
import { Typography } from '@shared/ui/typography';
import { useMcpServerTools } from '@entities/McpServer';
import { useCreatePermissions, PERMISSION_DECISIONS } from '@entities/Permission';
import type { McpToolsModalProps } from './McpToolsModal.types';
import styles from './McpToolsModal.module.scss';

/**
 * Помощник отбора инструментов MCP-сервера. Показывает, что сервер умеет, и
 * одним действием заводит права `mcp__<сервер>__<инструмент>` на выбранное.
 *
 * Логику записи прав не дублируем: отмеченные инструменты превращаются в черновики
 * и уходят в общий permission-API. Отдельный флажок «весь сервер» заводит одно
 * право `mcp__<сервер>` на все инструменты сразу.
 */
export function McpToolsModal({ isOpen, onOpenChange, server }: McpToolsModalProps) {
  const { t } = useTranslation();
  const tools = useMcpServerTools();
  const createPermissions = useCreatePermissions();

  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [wholeServer, setWholeServer] = useState(false);
  const [decision, setDecision] = useState<PermissionDecision>('allow');

  // Открыли — сбрасываем выбор и заново тянем список: сервер мог измениться.
  useEffect(() => {
    if (!isOpen) return;
    setSelected(new Set());
    setWholeServer(false);
    setDecision('allow');
    tools.mutate(server.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, server.id]);

  const list = tools.data?.tools ?? [];

  const toggle = (name: string): void => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  };

  const selectAll = (): void => setSelected(new Set(list.map((tool) => tool.name)));
  const clear = (): void => setSelected(new Set());

  // Имя сервера — это и есть его идентификатор в правах; инструмент отделяется
  // двойным подчёркиванием, ровно как разбирает сервер (MCP_PATTERN).
  const patterns = [
    ...(wholeServer ? [`mcp__${server.name}`] : []),
    ...[...selected].map((name) => `mcp__${server.name}__${name}`),
  ];

  const count = patterns.length;

  const handleCreate = (): void => {
    const drafts: PermissionDraft[] = patterns.map((pattern) => ({
      pattern,
      decision,
      groupIds: [],
    }));

    createPermissions.mutate(drafts, { onSuccess: () => onOpenChange(false) });
  };

  return (
    <Modal
      isOpen={isOpen}
      onOpenChange={onOpenChange}
      title={`${t('mcp.toolsTitle')}: ${server.name}`}
      description={t('common.needsRestart')}
      size="lg"
      footer={
        <>
          <Button onClick={() => onOpenChange(false)}>{t('common.cancel')}</Button>
          <Button
            variant="primary"
            onClick={handleCreate}
            disabled={count === 0 || createPermissions.isPending}
            isLoading={createPermissions.isPending}
          >
            {t('mcp.createPermissions', { count })}
          </Button>
        </>
      }
    >
      <Stack gap="var(--spacing-md)">
        {tools.isPending && <Typography color="muted">{t('mcp.toolsLoading')}</Typography>}

        {tools.data?.error && (
          <Typography variant="body-sm" color="danger">
            {tools.data.error}
          </Typography>
        )}

        {!tools.isPending && !tools.data?.error && list.length === 0 && (
          <Typography color="subtle">{t('mcp.toolsEmpty')}</Typography>
        )}

        {list.length > 0 && (
          <>
            <Stack direction="row" align="center" gap="var(--spacing-2xs)" wrap>
              <Button size="sm" variant="ghost" onClick={selectAll}>
                {t('mcp.toolsSelectAll')}
              </Button>
              <Button size="sm" variant="ghost" onClick={clear}>
                {t('mcp.toolsClear')}
              </Button>
              <Typography variant="caption" color="subtle" as="span">
                {t('mcp.toolsSelected', { count: selected.size })}
              </Typography>
            </Stack>

            <label className={styles.row}>
              <input
                type="checkbox"
                checked={wholeServer}
                onChange={() => setWholeServer((prev) => !prev)}
              />
              <Stack gap="var(--spacing-3xs)">
                <Typography variant="body-sm" weight="medium" as="span">
                  {t('mcp.wholeServer')}
                </Typography>
                <Typography variant="mono" color="subtle" as="span">
                  {`mcp__${server.name}`}
                </Typography>
              </Stack>
            </label>

            <Stack className={styles.list}>
              {list.map((tool) => (
                <label key={tool.name} className={styles.row}>
                  <input
                    type="checkbox"
                    checked={selected.has(tool.name)}
                    onChange={() => toggle(tool.name)}
                  />
                  <Stack gap="var(--spacing-3xs)" minWidth={0}>
                    <Typography variant="mono" weight="medium" as="span">
                      {tool.name}
                    </Typography>
                    {tool.description && (
                      <Typography variant="caption" color="subtle" as="span">
                        {tool.description}
                      </Typography>
                    )}
                  </Stack>
                </label>
              ))}
            </Stack>

            <Stack gap="var(--spacing-2xs)">
              <Typography variant="body-sm" weight="medium" as="span">
                {t('permissions.decision')}
              </Typography>
              <Stack direction="row" gap="var(--spacing-2xs)" wrap>
                {PERMISSION_DECISIONS.map((item) => (
                  <Button
                    key={item}
                    size="sm"
                    variant={decision === item ? 'primary' : 'secondary'}
                    onClick={() => setDecision(item)}
                  >
                    {t(`permissions.${item}`)}
                  </Button>
                ))}
              </Stack>
              <Typography variant="caption" color="subtle">
                {t(`permissions.decisionHint_${decision}`)}
              </Typography>
            </Stack>
          </>
        )}
      </Stack>
    </Modal>
  );
}
