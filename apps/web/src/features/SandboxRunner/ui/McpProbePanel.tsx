import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Stack } from '@shared/ui/stack';
import { Typography } from '@shared/ui/typography';
import { Button } from '@shared/ui/button';
import { TextField } from '@shared/ui/text-field';
import { SelectField } from '@shared/ui/select-field';
import { Icon } from '@shared/ui/icon';
import { useMcpTools, useCallMcpTool } from '@entities/Sandbox';
import styles from './SandboxModal.module.scss';

/**
 * Стенд MCP-сервера: какие инструменты он даёт и что отвечает на вызов.
 *
 * Проверка на странице серверов говорит только «отзывается или нет». Здесь
 * видно содержимое: список инструментов с описаниями и настоящий ответ на
 * вызов с заданными параметрами.
 */
export function McpProbePanel({ mcpId }: { mcpId: string }) {
  const { t } = useTranslation();
  const tools = useMcpTools();
  const call = useCallMcpTool();

  const [tool, setTool] = useState('');
  const [args, setArgs] = useState('{}');

  // Список инструментов тянем ровно на смену сервера. Сама мутация меняет
  // идентичность на каждом рендере, поэтому держим её в ref — иначе эффект
  // зациклился бы на собственном результате.
  const loadTools = useRef(tools.mutate);
  loadTools.current = tools.mutate;

  useEffect(() => {
    loadTools.current(mcpId);
  }, [mcpId]);

  const list = tools.data?.tools ?? [];
  const current = list.find((item) => item.name === tool);

  const invoke = (): void => {
    let parsed: Record<string, unknown> = {};

    try {
      parsed = JSON.parse(args || '{}') as Record<string, unknown>;
    } catch {
      // Разбирать нечего — отправим пустые параметры, сервер сам пожалуется.
    }

    call.mutate({ mcpId, tool, args: parsed });
  };

  return (
    <Stack gap="var(--spacing-sm)">
      {tools.isPending && <Typography color="muted">{t('sandbox.connecting')}</Typography>}

      {tools.data?.error && (
        <Typography variant="body-sm" color="danger">
          {tools.data.error}
        </Typography>
      )}

      {list.length > 0 && (
        <>
          <SelectField
            label={t('sandbox.tool')}
            value={tool}
            onChange={setTool}
            options={[
              { value: '', label: t('sandbox.chooseTool') },
              ...list.map((item) => ({ value: item.name, label: item.name })),
            ]}
            hint={current?.description}
          />

          <TextField
            label={t('sandbox.arguments')}
            value={args}
            onChange={setArgs}
            multiline
            rows={5}
            isMono
            hint={t('sandbox.argumentsHint')}
          />

          <Stack direction="row" align="center" gap="var(--spacing-xs)">
            <Button
              variant="primary"
              leftIcon={<Icon name="send" size={24} />}
              onClick={invoke}
              disabled={!tool}
              isLoading={call.isPending}
            >
              {t('sandbox.callTool')}
            </Button>

            {call.data && (
              <Typography variant="caption" color="subtle" as="span">
                {call.data.durationMs} мс
              </Typography>
            )}
          </Stack>

          {call.data && (
            <Stack gap="var(--spacing-3xs)">
              <Typography
                variant="body-sm"
                color={call.data.isError ? 'danger' : 'success'}
                weight="medium"
              >
                {call.data.isError ? t('sandbox.callFailed') : t('sandbox.callOk')}
              </Typography>
              <div className={styles.output}>{call.data.content}</div>
            </Stack>
          )}

          {/* Схема параметров подсказывает, что вообще можно передать. */}
          {current?.inputSchema !== undefined && (
            <Stack gap="var(--spacing-3xs)">
              <Typography variant="caption" color="subtle">
                {t('sandbox.schema')}
              </Typography>
              <div className={styles.output}>{JSON.stringify(current.inputSchema, null, 2)}</div>
            </Stack>
          )}
        </>
      )}
    </Stack>
  );
}
