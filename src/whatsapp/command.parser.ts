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

/**
 * Every free-text phrase the bot understands, keyed by its ALREADY-NORMALIZED
 * form (see `normalizeText`): lowercase, no diacritics, single-spaced. Each
 * button/list action the bot can send has at least one typeable synonym here,
 * so nothing is reachable only by tapping.
 *
 * `SELECT_EVENT` is deliberately absent — see the note at the end of
 * `parseText`.
 */
const TEXT_COMMANDS: Record<string, BotIntent> = {
  // MENU
  menu: { kind: 'MENU' },
  help: { kind: 'MENU' },
  ayuda: { kind: 'MENU' },
  opciones: { kind: 'MENU' },
  inicio: { kind: 'MENU' },
  comandos: { kind: 'MENU' },
  hola: { kind: 'MENU' },
  empezar: { kind: 'MENU' },
  start: { kind: 'MENU' },

  // MENU_MORE
  mas: { kind: 'MENU_MORE' },
  'mas opciones': { kind: 'MENU_MORE' },
  'otras opciones': { kind: 'MENU_MORE' },
  'ver opciones': { kind: 'MENU_MORE' },

  // LIST_EVENTS
  eventos: { kind: 'LIST_EVENTS' },
  'mis eventos': { kind: 'LIST_EVENTS' },
  'ver eventos': { kind: 'LIST_EVENTS' },
  'listar eventos': { kind: 'LIST_EVENTS' },
  'cambiar evento': { kind: 'LIST_EVENTS' },
  'elegir evento': { kind: 'LIST_EVENTS' },
  'otro evento': { kind: 'LIST_EVENTS' },

  // EVENT_DETAIL
  detalle: { kind: 'EVENT_DETAIL' },
  'detalle del evento': { kind: 'EVENT_DETAIL' },
  informacion: { kind: 'EVENT_DETAIL' },
  info: { kind: 'EVENT_DETAIL' },
  'ver evento': { kind: 'EVENT_DETAIL' },
  'datos del evento': { kind: 'EVENT_DETAIL' },

  // RSVP_SUMMARY
  resumen: { kind: 'RSVP_SUMMARY' },
  estadisticas: { kind: 'RSVP_SUMMARY' },
  totales: { kind: 'RSVP_SUMMARY' },
  conteo: { kind: 'RSVP_SUMMARY' },
  numeros: { kind: 'RSVP_SUMMARY' },

  // CANCEL
  cancelar: { kind: 'CANCEL' },
  cancela: { kind: 'CANCEL' },
  salir: { kind: 'CANCEL' },
  abortar: { kind: 'CANCEL' },
  descartar: { kind: 'CANCEL' },

  // START_ADD_GUEST
  agregar: { kind: 'START_ADD_GUEST' },
  'agregar invitado': { kind: 'START_ADD_GUEST' },
  'agregar usuario': { kind: 'START_ADD_GUEST' },
  'agregar persona': { kind: 'START_ADD_GUEST' },
  'anadir invitado': { kind: 'START_ADD_GUEST' },
  'nuevo invitado': { kind: 'START_ADD_GUEST' },
  'sumar invitado': { kind: 'START_ADD_GUEST' },
  'alta invitado': { kind: 'START_ADD_GUEST' },

  // CONFIRM_ACTION — `si` is the normalized form of "sí".
  confirmar: { kind: 'CONFIRM_ACTION' },
  confirmo: { kind: 'CONFIRM_ACTION' },
  si: { kind: 'CONFIRM_ACTION' },
  ok: { kind: 'CONFIRM_ACTION' },
  dale: { kind: 'CONFIRM_ACTION' },
  correcto: { kind: 'CONFIRM_ACTION' },
  acepto: { kind: 'CONFIRM_ACTION' },

  // RESUME_EVENT — answers the post-inactivity "same event?" gate.
  continuar: { kind: 'RESUME_EVENT' },
  'si continuar': { kind: 'RESUME_EVENT' },
  seguir: { kind: 'RESUME_EVENT' },
  'mismo evento': { kind: 'RESUME_EVENT' },

  // FILTER_BY_STATUS — bare status words, mirroring the "Ver confirmados"
  // style list rows. The `filtrar <estado>` phrasing is handled by pattern.
  confirmados: { kind: 'FILTER_BY_STATUS', status: 'ACCEPTED' },
  pendientes: { kind: 'FILTER_BY_STATUS', status: 'PENDING' },
  rechazados: { kind: 'FILTER_BY_STATUS', status: 'DECLINED' },
};

const SELECT_EVENT_PATTERN = /^select_event:(.+)$/;
const FILTER_BUTTON_PATTERN = /^filter:(confirmados|pendientes|rechazados)$/;
const SEARCH_TEXT_PATTERN = /^(?:buscar\s+invitado|buscar|busca|status)\s+(.+)$/i;
const FILTER_TEXT_PATTERN = /^filtrar\s+(confirmados|pendientes|rechazados)$/;
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
    case 'menu_more':
      return { kind: 'MENU_MORE' };
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
    case 'resume_event':
      return { kind: 'RESUME_EVENT' };
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

/**
 * Canonical form used for ALL keyword matching: lowercased, diacritics
 * stripped, internal whitespace collapsed, and surrounding punctuation
 * removed. This is what makes `Menú`, `MENU`, `  menú  ` and `¿menú?` all
 * resolve to the same command instead of falling through to UNKNOWN.
 */
export function normalizeText(input: string): string {
  return input
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    // Commas/semicolons act as word separators so a user echoing a button
    // label verbatim ("Si, continuar") still matches its phrase.
    .replace(/[,;]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^[¿¡?!.,\s]+/, '')
    .replace(/[¿¡?!.,\s]+$/, '');
}

function parseText(text: string): BotIntent {
  const normalized = normalizeText(text);

  // `hasOwnProperty` guard: a bare index would resolve inherited keys such as
  // "constructor" or "toString" to Object.prototype members.
  if (Object.prototype.hasOwnProperty.call(TEXT_COMMANDS, normalized)) {
    return TEXT_COMMANDS[normalized];
  }

  // Matched on the ORIGINAL text so the search term keeps its casing and
  // accents (guest names are matched against the database as typed).
  const searchMatch = text.match(SEARCH_TEXT_PATTERN);
  if (searchMatch) {
    return { kind: 'SEARCH_GUEST', term: searchMatch[1].trim() };
  }

  const filterMatch = normalized.match(FILTER_TEXT_PATTERN);
  if (filterMatch) {
    return { kind: 'FILTER_BY_STATUS', status: FILTER_STATUS_MAP[filterMatch[1]] };
  }

  // "seleccionar evento" and any other free-text attempt at event selection
  // is deliberately NOT recognized here — that command is button/list only.
  return { kind: 'UNKNOWN' };
}
