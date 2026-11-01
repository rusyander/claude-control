import type { IncomingMessage } from 'node:http';
import { isUuidv7 } from '@agentdeck/contracts/core/ids';
import type { CommandProof } from '../policy/authority/authority.ts';
import { verifyDeviceSignature } from '../policy/authority/device-signature.ts';
import { classifyPeer, type TokenClass } from './auth.ts';
import type { RouteContext } from './route-context.types.ts';

/**
 * Доказательство человека для ручки вне `/v1/commands` (`/v1/estimate`, `/v1/config`): те же
 * части — число страницы, пир, подпись устройства, — но подпись над СВОИМ адресом и телом без
 * `proof`: подпись одной ручки не годится другой.
 */
export async function proofOfBody(
  request: IncomingMessage,
  route: string,
  body: { proof: { nonce?: string; page?: string; signature?: string } },
  token: TokenClass,
  ctx: RouteContext['proof'],
): Promise<CommandProof> {
  const page = body.proof.page;
  const nonce = ctx.nonces.consume(body.proof.nonce, page && isUuidv7(page) ? page : undefined);
  const peer = await classifyPeer(request, ctx.peer);
  let signature: CommandProof['signature'] = 'absent';
  if (body.proof.signature !== undefined) {
    const { proof: _proof, ...signed } = body;
    const checked = verifyDeviceSignature(
      { route, params: {}, body: signed, header: body.proof.signature },
      {
        machineId: ctx.signature.machineId,
        now: ctx.signature.now(),
        devices: ctx.signature.devices(),
      },
    );
    signature =
      checked.ok && ctx.seen.claim(`${checked.deviceId}:${checked.nonce}`) ? 'valid' : 'invalid';
  }
  return { token, nonce, peer, signature };
}
