export type RsvpFilterStatus = 'ACCEPTED' | 'PENDING' | 'DECLINED';

/**
 * Typed union of every command the bot can recognize from an inbound
 * WhatsApp message (free text or an interactive button/list reply).
 *
 * Slice 3 scope: READ commands only. Write flows (agregar/editar,
 * confirmar/rechazar) are introduced in Slice 4 and are intentionally
 * absent from this union until then.
 */
export type BotIntent =
  | { kind: 'MENU' }
  | { kind: 'LIST_EVENTS' }
  | { kind: 'SELECT_EVENT'; eventId: string }
  | { kind: 'EVENT_DETAIL' }
  | { kind: 'SEARCH_GUEST'; term: string }
  | { kind: 'FILTER_BY_STATUS'; status: RsvpFilterStatus }
  | { kind: 'RSVP_SUMMARY' }
  | { kind: 'CANCEL' }
  | { kind: 'UNKNOWN' };
