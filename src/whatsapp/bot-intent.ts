export type RsvpFilterStatus = 'ACCEPTED' | 'PENDING' | 'DECLINED';

/**
 * Typed union of every command the bot can recognize from an inbound
 * WhatsApp message (free text or an interactive button/list reply).
 *
 * Slice 4 adds write-flow intents: starting the agregar/editar state
 * machines, confirming a pending write-flow step, and the button-only
 * confirmar/rechazar RSVP actions.
 */
export type BotIntent =
  | { kind: 'MENU' }
  | { kind: 'MENU_MORE' }
  | { kind: 'LIST_EVENTS' }
  | { kind: 'SELECT_EVENT'; eventId: string }
  | { kind: 'EVENT_DETAIL' }
  | { kind: 'SEARCH_GUEST'; term: string }
  | { kind: 'FILTER_BY_STATUS'; status: RsvpFilterStatus }
  | { kind: 'RSVP_SUMMARY' }
  | { kind: 'CANCEL' }
  | { kind: 'START_ADD_GUEST' }
  | { kind: 'START_EDIT_GUEST'; guestId: string }
  | { kind: 'CONFIRM_ACTION' }
  | { kind: 'RSVP_CONFIRM'; guestId: string }
  | { kind: 'RSVP_DECLINE'; guestId: string }
  | { kind: 'UNKNOWN' };
