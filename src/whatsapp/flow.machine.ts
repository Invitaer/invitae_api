/**
 * Pure write-flow state machine — zero I/O, zero NestJS dependencies.
 * `whatsapp.service` is the only caller: it feeds raw user input through
 * `advanceFlow` and, on a `COMPLETE` result, performs the actual
 * `GuestsService.create`/`.update` write itself. This module never talks to
 * a database or the WhatsApp API, which keeps every transition trivially
 * unit-testable (see `flow.machine.spec.ts`).
 */

export interface AddGuestFlowData {
  name?: string;
  phone?: string;
  tickets?: number;
  email?: string;
}

export interface AddGuestFlowState {
  flow: 'AGREGAR';
  step: 'ASK_NAME' | 'ASK_PHONE' | 'ASK_TICKETS' | 'ASK_EMAIL' | 'CONFIRM';
  data: AddGuestFlowData;
}

export type EditableField = 'name' | 'phone' | 'email' | 'tickets';

export interface EditGuestFlowState {
  flow: 'EDITAR';
  step: 'PICK_FIELD' | 'ASK_VALUE' | 'CONFIRM';
  guestId: string;
  field?: EditableField;
  value?: string | number;
}

export type PendingAction = AddGuestFlowState | EditGuestFlowState;

export type FlowAction =
  | { type: 'INPUT'; value: string }
  | { type: 'CONFIRM' }
  | { type: 'CANCEL' };

export type FlowResult =
  | { status: 'INVALID'; pending: PendingAction; message: string }
  | { status: 'ADVANCED'; pending: PendingAction; message: string }
  | { status: 'AWAITING_CONFIRM'; pending: PendingAction; message: string }
  | { status: 'COMPLETE'; pending: PendingAction; message: string }
  | { status: 'CANCELLED'; message: string };

const PHONE_PATTERN = /^\+?\d{8,15}$/;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const EDIT_FIELD_LABELS: Record<string, EditableField> = {
  nombre: 'name',
  telefono: 'phone',
  email: 'email',
  tickets: 'tickets',
};

export function startAddGuestFlow(): AddGuestFlowState {
  return { flow: 'AGREGAR', step: 'ASK_NAME', data: {} };
}

export function startEditGuestFlow(guestId: string): EditGuestFlowState {
  return { flow: 'EDITAR', step: 'PICK_FIELD', guestId };
}

/**
 * Single entry point for every write-flow transition. `CANCEL` and
 * `CONFIRM` are handled uniformly for both flows; `INPUT` delegates to the
 * flow-specific step handler.
 */
export function advanceFlow(pending: PendingAction, action: FlowAction): FlowResult {
  if (action.type === 'CANCEL') {
    return { status: 'CANCELLED', message: 'Operacion cancelada.' };
  }

  if (action.type === 'CONFIRM') {
    if (pending.step !== 'CONFIRM') {
      return {
        status: 'INVALID',
        pending,
        message: 'Todavia faltan datos antes de poder confirmar.',
      };
    }
    return { status: 'COMPLETE', pending, message: 'Confirmado.' };
  }

  return pending.flow === 'AGREGAR'
    ? advanceAddGuestFlow(pending, action.value)
    : advanceEditGuestFlow(pending, action.value);
}

function advanceAddGuestFlow(pending: AddGuestFlowState, input: string): FlowResult {
  const value = input.trim();

  switch (pending.step) {
    case 'ASK_NAME': {
      if (!value) {
        return { status: 'INVALID', pending, message: 'Ingresa un nombre valido.' };
      }
      const next: AddGuestFlowState = {
        ...pending,
        step: 'ASK_PHONE',
        data: { ...pending.data, name: value },
      };
      return { status: 'ADVANCED', pending: next, message: 'Ingresa el telefono (8 a 15 digitos).' };
    }

    case 'ASK_PHONE': {
      if (!PHONE_PATTERN.test(value)) {
        return {
          status: 'INVALID',
          pending,
          message: 'Telefono invalido. Debe tener entre 8 y 15 digitos (podes incluir +).',
        };
      }
      const next: AddGuestFlowState = {
        ...pending,
        step: 'ASK_TICKETS',
        data: { ...pending.data, phone: value },
      };
      return { status: 'ADVANCED', pending: next, message: 'Cuantos tickets?' };
    }

    case 'ASK_TICKETS': {
      const tickets = parseTickets(value);
      if (tickets === undefined) {
        return {
          status: 'INVALID',
          pending,
          message: 'Cantidad de tickets invalida. Debe ser un numero entero mayor o igual a 1.',
        };
      }
      const next: AddGuestFlowState = {
        ...pending,
        step: 'ASK_EMAIL',
        data: { ...pending.data, tickets },
      };
      return {
        status: 'ADVANCED',
        pending: next,
        message: 'Email (opcional). Envia "skip" para omitir.',
      };
    }

    case 'ASK_EMAIL': {
      const email = parseOptionalEmail(value);
      if (email === 'INVALID') {
        return { status: 'INVALID', pending, message: 'Email invalido.' };
      }
      const next: AddGuestFlowState = {
        ...pending,
        step: 'CONFIRM',
        data: { ...pending.data, email },
      };
      return {
        status: 'AWAITING_CONFIRM',
        pending: next,
        message: buildAddGuestSummary(next.data),
      };
    }

    case 'CONFIRM':
    default:
      return {
        status: 'INVALID',
        pending,
        message: 'Confirma con el boton de confirmar, o cancelar para descartar.',
      };
  }
}

function advanceEditGuestFlow(pending: EditGuestFlowState, input: string): FlowResult {
  switch (pending.step) {
    case 'PICK_FIELD':
      return pickEditField(pending, input);
    case 'ASK_VALUE':
      return askEditValue(pending, input);
    case 'CONFIRM':
    default:
      return {
        status: 'INVALID',
        pending,
        message: 'Confirma con el boton de confirmar, o cancelar para descartar.',
      };
  }
}

function pickEditField(pending: EditGuestFlowState, input: string): FlowResult {
  const key = input.trim().toLowerCase();
  const field = EDIT_FIELD_LABELS[key];
  if (!field) {
    return {
      status: 'INVALID',
      pending,
      message: 'Campo invalido. Elegi: nombre, telefono, email o tickets.',
    };
  }
  const next: EditGuestFlowState = { ...pending, step: 'ASK_VALUE', field };
  return { status: 'ADVANCED', pending: next, message: `Ingresa el nuevo valor para ${key}.` };
}

function askEditValue(pending: EditGuestFlowState, input: string): FlowResult {
  const value = input.trim();
  const field = pending.field;

  if (!field) {
    return { status: 'INVALID', pending, message: 'No se selecciono ningun campo para editar.' };
  }

  if (field === 'phone' && !PHONE_PATTERN.test(value)) {
    return {
      status: 'INVALID',
      pending,
      message: 'Telefono invalido. Debe tener entre 8 y 15 digitos (podes incluir +).',
    };
  }

  if (field === 'email' && !EMAIL_PATTERN.test(value)) {
    return { status: 'INVALID', pending, message: 'Email invalido.' };
  }

  if (field === 'name' && !value) {
    return { status: 'INVALID', pending, message: 'Ingresa un nombre valido.' };
  }

  let parsedValue: string | number = value;
  if (field === 'tickets') {
    const tickets = parseTickets(value);
    if (tickets === undefined) {
      return {
        status: 'INVALID',
        pending,
        message: 'Cantidad de tickets invalida. Debe ser un numero entero mayor o igual a 1.',
      };
    }
    parsedValue = tickets;
  }

  const next: EditGuestFlowState = { ...pending, step: 'CONFIRM', value: parsedValue };
  return {
    status: 'AWAITING_CONFIRM',
    pending: next,
    message: `Confirmas el cambio de ${field} a "${value}"?`,
  };
}

function parseTickets(value: string): number | undefined {
  const tickets = Number(value);
  if (!Number.isInteger(tickets) || tickets < 1) {
    return undefined;
  }
  return tickets;
}

function parseOptionalEmail(value: string): string | undefined | 'INVALID' {
  if (!value || value.toLowerCase() === 'skip') {
    return undefined;
  }
  return EMAIL_PATTERN.test(value) ? value : 'INVALID';
}

function buildAddGuestSummary(data: AddGuestFlowData): string {
  return [
    'Confirmas agregar este invitado?',
    `Nombre: ${data.name}`,
    `Telefono: ${data.phone}`,
    `Tickets: ${data.tickets}`,
    `Email: ${data.email ?? 'sin especificar'}`,
  ].join('\n');
}
