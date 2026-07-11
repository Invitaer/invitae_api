import { BotIntent, RsvpFilterStatus } from './bot-intent';

export interface ParserInput {
  /** Free-text message body, if the inbound message was plain text. */
  text?: string;
  /**
   * `id` of an interactive button/list reply (Meta's `button_reply.id` or
   * `list_reply.id`). Commands that must never be triggered by free-text
   * NLP (menu navigation, event selection) are only recognized here.
   */
  interactiveId?: string;
}

const FILTER_STATUS_MAP: Record<string, RsvpFilterStatus> = {
  confirmados: 'ACCEPTED',
  pendientes: 'PENDING',
  rechazados: 'DECLINED',
};

const SELECT_EVENT_PATTERN = /^select_event:(.+)$/;
const FILTER_BUTTON_PATTERN = /^filter:(confirmados|pendientes|rechazados)$/;
const SEARCH_TEXT_PATTERN = /^(?:buscar|status)\s+(.+)$/i;
const FILTER_TEXT_PATTERN = /^filtrar\s+(confirmados|pendientes|rechazados)$/i;
const EDIT_GUEST_PATTERN = /^edit_guest:(.+)$/;
const RSVP_CONFIRM_PATTERN = /^confirmar:(.+)$/;
const RSVP_DECLINE_PATTERN = /^rechazar:(.+)$/;

/**
 * Pure parser: (text | interactiveId) -> BotIntent. No I/O, no service
 * dependencies — fully unit-testable without a WhatsApp connection.
 *
 * When both an interactive reply id and text are present, the interactive
 * id takes precedence (buttons/lists are deterministic; text is not).
 */
export function parseCommand(input: ParserInput): BotIntent {
  const interactiveId = input.interactiveId?.trim();
  if (interactiveId) {
    const fromInteractive = parseInteractiveId(interactiveId);
    if (fromInteractive) {
      return fromInteractive;
    }
  }

  const text = input.text?.trim() ?? '';
  if (!text) {
    return { kind: 'UNKNOWN' };
  }

  return parseText(text);
}

function parseInteractiveId(interactiveId: string): BotIntent | undefined {
  switch (interactiveId) {
    case 'menu':
      return { kind: 'MENU' };
    case 'list_events':
      return { kind: 'LIST_EVENTS' };
    case 'detalle':
      return { kind: 'EVENT_DETAIL' };
    case 'resumen':
      return { kind: 'RSVP_SUMMARY' };
    case 'cancel':
      return { kind: 'CANCEL' };
    case 'add_guest':
      return { kind: 'START_ADD_GUEST' };
    case 'confirm':
      return { kind: 'CONFIRM_ACTION' };
  }

  const selectMatch = interactiveId.match(SELECT_EVENT_PATTERN);
  if (selectMatch) {
    return { kind: 'SELECT_EVENT', eventId: selectMatch[1] };
  }

  const filterMatch = interactiveId.match(FILTER_BUTTON_PATTERN);
  if (filterMatch) {
    return { kind: 'FILTER_BY_STATUS', status: FILTER_STATUS_MAP[filterMatch[1]] };
  }

  const editGuestMatch = interactiveId.match(EDIT_GUEST_PATTERN);
  if (editGuestMatch) {
    return { kind: 'START_EDIT_GUEST', guestId: editGuestMatch[1] };
  }

  // "confirmar:{id}"/"rechazar:{id}" (RSVP status change) are distinct ids
  // from the flow-gate "confirm" handled above — no ambiguity between the
  // two button namespaces.
  const rsvpConfirmMatch = interactiveId.match(RSVP_CONFIRM_PATTERN);
  if (rsvpConfirmMatch) {
    return { kind: 'RSVP_CONFIRM', guestId: rsvpConfirmMatch[1] };
  }

  const rsvpDeclineMatch = interactiveId.match(RSVP_DECLINE_PATTERN);
  if (rsvpDeclineMatch) {
    return { kind: 'RSVP_DECLINE', guestId: rsvpDeclineMatch[1] };
  }

  return undefined;
}

function parseText(text: string): BotIntent {
  const lower = text.toLowerCase();

  if (lower === 'menu' || lower === 'help' || lower === 'ayuda') {
    return { kind: 'MENU' };
  }
  if (lower === 'mis eventos' || lower === 'eventos') {
    return { kind: 'LIST_EVENTS' };
  }
  if (lower === 'detalle') {
    return { kind: 'EVENT_DETAIL' };
  }
  if (lower === 'resumen') {
    return { kind: 'RSVP_SUMMARY' };
  }
  if (lower === 'cancelar') {
    return { kind: 'CANCEL' };
  }
  if (lower === 'agregar' || lower === 'agregar invitado') {
    return { kind: 'START_ADD_GUEST' };
  }

  // Case-insensitive keyword match, but preserve original casing of the
  // search term itself (guest names may be case-sensitive to the user).
  const searchMatch = text.match(SEARCH_TEXT_PATTERN);
  if (searchMatch) {
    return { kind: 'SEARCH_GUEST', term: searchMatch[1].trim() };
  }

  const filterMatch = lower.match(FILTER_TEXT_PATTERN);
  if (filterMatch) {
    return { kind: 'FILTER_BY_STATUS', status: FILTER_STATUS_MAP[filterMatch[1]] };
  }

  // "seleccionar evento" and any other free-text attempt at event selection
  // is deliberately NOT recognized here — that command is button/list only.
  return { kind: 'UNKNOWN' };
}
