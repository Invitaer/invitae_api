import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  RawBodyRequest,
} from '@nestjs/common';
import type { Request } from 'express';
import * as crypto from 'crypto';
import { secrets } from '../../config/secrets';

const SIGNATURE_HEADER = 'x-hub-signature-256';

@Injectable()
export class WhatsappSignatureGuard implements CanActivate {
  canActivate(ctx: ExecutionContext): boolean {
    const request = ctx.switchToHttp().getRequest<RawBodyRequest<Request>>();
    const signatureHeader = request.headers[SIGNATURE_HEADER] as string | undefined;
    const rawBody = request.rawBody;

    if (!signatureHeader || !rawBody) {
      throw new ForbiddenException('Missing WhatsApp signature');
    }

    const expectedSignature =
      'sha256=' +
      crypto
        .createHmac('sha256', secrets.WHATSAPP_APP_SECRET)
        .update(rawBody)
        .digest('hex');

    const expectedBuffer = Buffer.from(expectedSignature);
    const receivedBuffer = Buffer.from(signatureHeader);

    const isValid =
      expectedBuffer.length === receivedBuffer.length &&
      crypto.timingSafeEqual(expectedBuffer, receivedBuffer);

    if (!isValid) {
      throw new ForbiddenException('Invalid WhatsApp signature');
    }

    return true;
  }
}
