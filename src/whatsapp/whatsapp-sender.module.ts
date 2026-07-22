import { Module } from '@nestjs/common';
import { WhatsappClient } from './whatsapp.client';

/**
 * Leaf module for the outbound WhatsApp sender. `WhatsappClient` has a
 * zero-argument constructor and depends only on `config/secrets` and
 * `phone.util` — it is already a leaf, so this module has NO imports.
 *
 * This exists to break a real dependency cycle:
 *
 *   NotificationsModule -> WhatsappModule -> UserEventsModule -> NotificationsModule
 *
 * Exporting `WhatsappClient` from `WhatsappModule` directly (or papering
 * over the cycle with `forwardRef`) is deliberately avoided — see
 * `sdd/guest-whatsapp-notify/design` decision D1. Both `WhatsappModule` and
 * `NotificationsModule` import this module instead, which makes the cycle
 * structurally impossible.
 */
@Module({
  providers: [WhatsappClient],
  exports: [WhatsappClient],
})
export class WhatsappSenderModule {}
