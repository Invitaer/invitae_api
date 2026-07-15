// Mock secrets before any imports to prevent validation side-effects at import time
jest.mock('../../config/secrets', () => ({
  secrets: {
    WHATSAPP_APP_SECRET: 'test-app-secret',
  },
}));

import * as crypto from 'crypto';
import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { WhatsappSignatureGuard } from './whatsapp-signature.guard';

const APP_SECRET = 'test-app-secret';

function sign(rawBody: Buffer): string {
  const hmac = crypto.createHmac('sha256', APP_SECRET).update(rawBody).digest('hex');
  return `sha256=${hmac}`;
}

function buildExecutionContext(
  rawBody: Buffer | undefined,
  signature: string | undefined,
): ExecutionContext {
  const request = {
    rawBody,
    headers: signature !== undefined ? { 'x-hub-signature-256': signature } : {},
  };

  return {
    switchToHttp: () => ({
      getRequest: () => request,
    }),
  } as unknown as ExecutionContext;
}

describe('WhatsappSignatureGuard', () => {
  let guard: WhatsappSignatureGuard;

  beforeEach(() => {
    guard = new WhatsappSignatureGuard();
  });

  it('allows the request when the signature matches the raw body HMAC', () => {
    const rawBody = Buffer.from(JSON.stringify({ entry: [] }));
    const signature = sign(rawBody);

    const ctx = buildExecutionContext(rawBody, signature);

    expect(guard.canActivate(ctx)).toBe(true);
  });

  it('rejects with ForbiddenException when the signature does not match', () => {
    const rawBody = Buffer.from(JSON.stringify({ entry: [] }));
    const ctx = buildExecutionContext(rawBody, 'sha256=deadbeef');

    expect(() => guard.canActivate(ctx)).toThrow(ForbiddenException);
  });

  it('rejects with ForbiddenException when the signature header is missing', () => {
    const rawBody = Buffer.from(JSON.stringify({ entry: [] }));
    const ctx = buildExecutionContext(rawBody, undefined);

    expect(() => guard.canActivate(ctx)).toThrow(ForbiddenException);
  });

  it('rejects with ForbiddenException when the raw body is missing', () => {
    const signature = sign(Buffer.from('{}'));
    const ctx = buildExecutionContext(undefined, signature);

    expect(() => guard.canActivate(ctx)).toThrow(ForbiddenException);
  });

  it('rejects a signature computed against a different body (tampering)', () => {
    const rawBody = Buffer.from(JSON.stringify({ entry: [{ tampered: true }] }));
    const signatureForDifferentBody = sign(Buffer.from(JSON.stringify({ entry: [] })));

    const ctx = buildExecutionContext(rawBody, signatureForDifferentBody);

    expect(() => guard.canActivate(ctx)).toThrow(ForbiddenException);
  });
});
