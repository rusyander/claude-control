import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { McpTransport } from '@claude-control/contracts';
import { Stack } from '@shared/ui/stack';
import { Modal } from '@shared/ui/modal';
import { Button } from '@shared/ui/button';
import { TextField } from '@shared/ui/text-field';
import { SelectField } from '@shared/ui/select-field';
import { Typography } from '@shared/ui/typography';
import { envToText, textToEnv, parseArgs, formatArgs } from '@shared/lib/env-text';
import { toErrorMessage } from '@shared/api/client';
import { MCP_TRANSPORTS } from '@entities/McpServer';
import { useCreateProjectMcp, useUpdateProjectMcp } from '@entities/Project';
import type { ProjectMcpFormProps } from './ProjectMcpForm.types';

/**
 * Добавление и правка MCP-сервера проекта (запись в `.mcp.json` в корне
 * проекта). Как и в пользовательской форме, поля зависят от транспорта: у stdio
 * это команда с аргументами, у sse/http — адрес.
 */
export function ProjectMcpForm({ isOpen, onOpenChange, projectId, server }: ProjectMcpFormProps) {
  const { t } = useTranslation();
  const [name, setName] = useState('');
  const [transport, setTransport] = useState<McpTransport>('stdio');
  const [command, setCommand] = useState('');
  const [args, setArgs] = useState('');
  const [url, setUrl] = useState('');
  const [envText, setEnvText] = useState('');
  const [headersText, setHeadersText] = useState('');

  const create = useCreateProjectMcp(projectId);
  const update = useUpdateProjectMcp(projectId);

  useEffect(() => {
    if (!isOpen) return;
    setName(server?.name ?? '');
    setTransport(server?.transport ?? 'stdio');
    setCommand(server?.command ?? '');
    setArgs(server ? formatArgs(server.args) : '');
    setUrl(server?.url ?? '');
    setEnvText(server ? envToText(server.env) : '');
    setHeadersText(server ? envToText(server.headers) : '');
  }, [isOpen, server]);

  const isPending = create.isPending || update.isPending;
  const isStdio = transport === 'stdio';
  const canSave =
    name.trim().length > 0 &&
    (isStdio ? command.trim().length > 0 : url.trim().length > 0) &&
    !isPending;

  const handleSave = (): void => {
    const draft = {
      name: name.trim(),
      transport,
      command: isStdio ? command.trim() : undefined,
      args: isStdio ? parseArgs(args) : [],
      url: isStdio ? undefined : url.trim(),
      env: textToEnv(envText),
      headers: isStdio ? {} : textToEnv(headersText),
      groupIds: [],
    };

    const onDone = { onSuccess: () => onOpenChange(false) };
    if (server) update.mutate({ id: server.id, draft }, onDone);
    else create.mutate(draft, onDone);
  };

  return (
    <Modal
      isOpen={isOpen}
      onOpenChange={onOpenChange}
      title={server ? `${t('common.edit')}: ${server.name}` : t('projectConfig.addMcp')}
      description={t('common.needsRestart')}
      size="md"
      footer={
        <>
          <Button onClick={() => onOpenChange(false)}>{t('common.cancel')}</Button>
          <Button variant="primary" onClick={handleSave} disabled={!canSave} isLoading={isPending}>
            {t('common.save')}
          </Button>
        </>
      }
    >
      <Stack gap="var(--spacing-md)">
        <TextField
          label={t('mcp.serverName')}
          value={name}
          onChange={setName}
          placeholder="например: playwright"
          hint={t('mcp.serverNameHint')}
          isMono
          autoFocus={!server}
        />

        <SelectField
          label={t('mcp.transport')}
          value={transport}
          onChange={(value) => setTransport(value as McpTransport)}
          options={MCP_TRANSPORTS.map((value) => ({ value, label: value }))}
          hint={t('mcp.transportHint')}
        />

        {isStdio ? (
          <>
            <TextField
              label={t('mcp.command')}
              value={command}
              onChange={setCommand}
              placeholder="npx"
              isMono
            />
            <TextField
              label={t('mcp.args')}
              value={args}
              onChange={setArgs}
              placeholder="-y @scope/mcp-server"
              hint={t('mcp.argsHint')}
              isMono
            />
          </>
        ) : (
          <>
            <TextField
              label={t('mcp.url')}
              value={url}
              onChange={setUrl}
              placeholder="http://127.0.0.1:3845/sse"
              isMono
            />
            <TextField
              label={t('mcp.headers')}
              value={headersText}
              onChange={setHeadersText}
              multiline
              rows={3}
              placeholder={'Authorization=Bearer ${MY_TOKEN}'}
              hint={t('mcp.headersHint')}
              isMono
            />
          </>
        )}

        <TextField
          label={t('mcp.env')}
          value={envText}
          onChange={setEnvText}
          multiline
          rows={4}
          placeholder={'MCP_SECRET_KEYS=TOKEN_A,TOKEN_B'}
          hint={t('mcp.envHint')}
          isMono
        />

        {(create.isError || update.isError) && (
          <Typography variant="body-sm" color="danger">
            {toErrorMessage(create.error ?? update.error)}
          </Typography>
        )}
      </Stack>
    </Modal>
  );
}
