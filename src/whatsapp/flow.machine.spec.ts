import {
  advanceFlow,
  startAddGuestFlow,
  startEditGuestFlow,
  AddGuestFlowState,
  EditGuestFlowState,
  FlowResult,
} from './flow.machine';

/**
 * Narrows a `FlowResult` to a specific `status` variant after asserting it,
 * so subsequent property access (e.g. `.pending`) type-checks without
 * scattering manual type guards across every test case.
 */
function expectStatus<S extends FlowResult['status']>(
  result: FlowResult,
  status: S,
): Extract<FlowResult, { status: S }> {
  expect(result.status).toBe(status);
  if (result.status !== status) {
    throw new Error(`Expected status ${status}, got ${result.status}`);
  }
  return result as Extract<FlowResult, { status: S }>;
}

describe('flow.machine', () => {
  describe('startAddGuestFlow', () => {
    it('starts at ASK_NAME with empty data', () => {
      expect(startAddGuestFlow()).toEqual({
        flow: 'AGREGAR',
        step: 'ASK_NAME',
        data: {},
      });
    });
  });

  describe('agregar invitado — ASK_NAME -> ASK_PHONE -> ASK_TICKETS -> ASK_EMAIL -> CONFIRM', () => {
    it('ASK_NAME: a valid name advances to ASK_PHONE and stores it', () => {
      const pending = startAddGuestFlow();
      const result = expectStatus(advanceFlow(pending, { type: 'INPUT', value: 'Juan Perez' }), 'ADVANCED');

      expect(result.pending).toEqual({
        flow: 'AGREGAR',
        step: 'ASK_PHONE',
        data: { name: 'Juan Perez' },
      });
    });

    it('ASK_NAME: an empty name is INVALID and does not advance', () => {
      const pending = startAddGuestFlow();
      const result = expectStatus(advanceFlow(pending, { type: 'INPUT', value: '   ' }), 'INVALID');

      expect(result.pending).toEqual(pending);
    });

    it('ASK_PHONE: a phone with fewer than 8 digits is INVALID and does not advance', () => {
      const pending: AddGuestFlowState = {
        flow: 'AGREGAR',
        step: 'ASK_PHONE',
        data: { name: 'Juan Perez' },
      };
      const result = expectStatus(advanceFlow(pending, { type: 'INPUT', value: '1234567' }), 'INVALID');

      expect(result.pending).toEqual(pending);
    });

    it('ASK_PHONE: a phone with more than 15 digits is INVALID and does not advance', () => {
      const pending: AddGuestFlowState = {
        flow: 'AGREGAR',
        step: 'ASK_PHONE',
        data: { name: 'Juan Perez' },
      };
      const result = expectStatus(
        advanceFlow(pending, { type: 'INPUT', value: '1234567890123456' }),
        'INVALID',
      );

      expect(result.pending).toEqual(pending);
    });

    it('ASK_PHONE: a valid 8-15 digit phone (optionally with +) advances to ASK_TICKETS', () => {
      const pending: AddGuestFlowState = {
        flow: 'AGREGAR',
        step: 'ASK_PHONE',
        data: { name: 'Juan Perez' },
      };
      const result = expectStatus(
        advanceFlow(pending, { type: 'INPUT', value: '+5491122334455' }),
        'ADVANCED',
      );

      expect(result.pending).toEqual({
        flow: 'AGREGAR',
        step: 'ASK_TICKETS',
        data: { name: 'Juan Perez', phone: '+5491122334455' },
      });
    });

    it('ASK_TICKETS: a non-integer value is INVALID and does not advance', () => {
      const pending: AddGuestFlowState = {
        flow: 'AGREGAR',
        step: 'ASK_TICKETS',
        data: { name: 'Juan Perez', phone: '+5491122334455' },
      };
      const result = expectStatus(advanceFlow(pending, { type: 'INPUT', value: 'dos' }), 'INVALID');

      expect(result.pending).toEqual(pending);
    });

    it('ASK_TICKETS: zero or negative tickets is INVALID and does not advance', () => {
      const pending: AddGuestFlowState = {
        flow: 'AGREGAR',
        step: 'ASK_TICKETS',
        data: { name: 'Juan Perez', phone: '+5491122334455' },
      };
      const result = expectStatus(advanceFlow(pending, { type: 'INPUT', value: '0' }), 'INVALID');

      expect(result.pending).toEqual(pending);
    });

    it('ASK_TICKETS: a valid integer >= 1 advances to ASK_EMAIL', () => {
      const pending: AddGuestFlowState = {
        flow: 'AGREGAR',
        step: 'ASK_TICKETS',
        data: { name: 'Juan Perez', phone: '+5491122334455' },
      };
      const result = expectStatus(advanceFlow(pending, { type: 'INPUT', value: '3' }), 'ADVANCED');

      expect(result.pending).toEqual({
        flow: 'AGREGAR',
        step: 'ASK_EMAIL',
        data: { name: 'Juan Perez', phone: '+5491122334455', tickets: 3 },
      });
    });

    it('ASK_EMAIL: an invalid email is INVALID and does not advance', () => {
      const pending: AddGuestFlowState = {
        flow: 'AGREGAR',
        step: 'ASK_EMAIL',
        data: { name: 'Juan Perez', phone: '+5491122334455', tickets: 3 },
      };
      const result = expectStatus(
        advanceFlow(pending, { type: 'INPUT', value: 'not-an-email' }),
        'INVALID',
      );

      expect(result.pending).toEqual(pending);
    });

    it('ASK_EMAIL: "skip" reaches CONFIRM with no email set', () => {
      const pending: AddGuestFlowState = {
        flow: 'AGREGAR',
        step: 'ASK_EMAIL',
        data: { name: 'Juan Perez', phone: '+5491122334455', tickets: 3 },
      };
      const result = expectStatus(
        advanceFlow(pending, { type: 'INPUT', value: 'skip' }),
        'AWAITING_CONFIRM',
      );

      expect(result.pending).toEqual({
        flow: 'AGREGAR',
        step: 'CONFIRM',
        data: { name: 'Juan Perez', phone: '+5491122334455', tickets: 3, email: undefined },
      });
    });

    it('ASK_EMAIL: a valid email reaches CONFIRM with the email stored', () => {
      const pending: AddGuestFlowState = {
        flow: 'AGREGAR',
        step: 'ASK_EMAIL',
        data: { name: 'Juan Perez', phone: '+5491122334455', tickets: 3 },
      };
      const result = expectStatus(
        advanceFlow(pending, { type: 'INPUT', value: 'juan@example.com' }),
        'AWAITING_CONFIRM',
      );

      expect(result.pending).toEqual({
        flow: 'AGREGAR',
        step: 'CONFIRM',
        data: {
          name: 'Juan Perez',
          phone: '+5491122334455',
          tickets: 3,
          email: 'juan@example.com',
        },
      });
    });

    it('CONFIRM: free-text input at CONFIRM step is INVALID (must use the confirm action, not text)', () => {
      const pending: AddGuestFlowState = {
        flow: 'AGREGAR',
        step: 'CONFIRM',
        data: { name: 'Juan Perez', phone: '+5491122334455', tickets: 3 },
      };
      const result = advanceFlow(pending, { type: 'INPUT', value: 'si' });

      expect(result.status).toBe('INVALID');
    });

    it('CONFIRM action before reaching CONFIRM step is INVALID and does not complete', () => {
      const pending: AddGuestFlowState = {
        flow: 'AGREGAR',
        step: 'ASK_PHONE',
        data: { name: 'Juan Perez' },
      };
      const result = advanceFlow(pending, { type: 'CONFIRM' });

      expect(result.status).toBe('INVALID');
    });

    it('CONFIRM action at the CONFIRM step COMPLETEs with the full collected data', () => {
      const pending: AddGuestFlowState = {
        flow: 'AGREGAR',
        step: 'CONFIRM',
        data: { name: 'Juan Perez', phone: '+5491122334455', tickets: 3, email: 'juan@example.com' },
      };
      const result = expectStatus(advanceFlow(pending, { type: 'CONFIRM' }), 'COMPLETE');

      expect(result.pending).toEqual(pending);
    });
  });

  describe('startEditGuestFlow', () => {
    it('starts at PICK_FIELD with the given guestId', () => {
      expect(startEditGuestFlow('guest-uuid-1')).toEqual({
        flow: 'EDITAR',
        step: 'PICK_FIELD',
        guestId: 'guest-uuid-1',
      });
    });
  });

  describe('editar invitado — PICK_FIELD -> ASK_VALUE -> CONFIRM', () => {
    it('PICK_FIELD: an unknown field name is INVALID and does not advance', () => {
      const pending: EditGuestFlowState = {
        flow: 'EDITAR',
        step: 'PICK_FIELD',
        guestId: 'guest-uuid-1',
      };
      const result = expectStatus(advanceFlow(pending, { type: 'INPUT', value: 'apellido' }), 'INVALID');

      expect(result.pending).toEqual(pending);
    });

    it('PICK_FIELD: "telefono" advances to ASK_VALUE with field=phone', () => {
      const pending: EditGuestFlowState = {
        flow: 'EDITAR',
        step: 'PICK_FIELD',
        guestId: 'guest-uuid-1',
      };
      const result = expectStatus(advanceFlow(pending, { type: 'INPUT', value: 'telefono' }), 'ADVANCED');

      expect(result.pending).toEqual({
        flow: 'EDITAR',
        step: 'ASK_VALUE',
        guestId: 'guest-uuid-1',
        field: 'phone',
      });
    });

    it('ASK_VALUE: an invalid phone value is INVALID and does not advance', () => {
      const pending: EditGuestFlowState = {
        flow: 'EDITAR',
        step: 'ASK_VALUE',
        guestId: 'guest-uuid-1',
        field: 'phone',
      };
      const result = expectStatus(advanceFlow(pending, { type: 'INPUT', value: '123' }), 'INVALID');

      expect(result.pending).toEqual(pending);
    });

    it('ASK_VALUE: a valid phone value reaches CONFIRM with the value stored', () => {
      const pending: EditGuestFlowState = {
        flow: 'EDITAR',
        step: 'ASK_VALUE',
        guestId: 'guest-uuid-1',
        field: 'phone',
      };
      const result = expectStatus(
        advanceFlow(pending, { type: 'INPUT', value: '+5491133445566' }),
        'AWAITING_CONFIRM',
      );

      expect(result.pending).toEqual({
        flow: 'EDITAR',
        step: 'CONFIRM',
        guestId: 'guest-uuid-1',
        field: 'phone',
        value: '+5491133445566',
      });
    });

    it('ASK_VALUE: a valid tickets value is parsed as a number', () => {
      const pending: EditGuestFlowState = {
        flow: 'EDITAR',
        step: 'ASK_VALUE',
        guestId: 'guest-uuid-1',
        field: 'tickets',
      };
      const result = expectStatus(advanceFlow(pending, { type: 'INPUT', value: '5' }), 'AWAITING_CONFIRM');

      expect(result.pending).toEqual({
        flow: 'EDITAR',
        step: 'CONFIRM',
        guestId: 'guest-uuid-1',
        field: 'tickets',
        value: 5,
      });
    });

    it('CONFIRM action at the CONFIRM step COMPLETEs with the field and value', () => {
      const pending: EditGuestFlowState = {
        flow: 'EDITAR',
        step: 'CONFIRM',
        guestId: 'guest-uuid-1',
        field: 'phone',
        value: '+5491133445566',
      };
      const result = expectStatus(advanceFlow(pending, { type: 'CONFIRM' }), 'COMPLETE');

      expect(result.pending).toEqual(pending);
    });
  });

  describe('cancelar — clears pendingAction at ANY step, no partial write', () => {
    it('CANCEL mid-AGREGAR flow (at ASK_PHONE) returns CANCELLED, not COMPLETE', () => {
      const pending: AddGuestFlowState = {
        flow: 'AGREGAR',
        step: 'ASK_PHONE',
        data: { name: 'Juan Perez' },
      };
      const result = advanceFlow(pending, { type: 'CANCEL' });

      expect(result.status).toBe('CANCELLED');
      expect(result).not.toHaveProperty('pending');
    });

    it('CANCEL mid-EDITAR flow (at ASK_VALUE) returns CANCELLED, not COMPLETE', () => {
      const pending: EditGuestFlowState = {
        flow: 'EDITAR',
        step: 'ASK_VALUE',
        guestId: 'guest-uuid-1',
        field: 'email',
      };
      const result = advanceFlow(pending, { type: 'CANCEL' });

      expect(result.status).toBe('CANCELLED');
      expect(result).not.toHaveProperty('pending');
    });

    it('CANCEL at the CONFIRM step (data fully collected) still returns CANCELLED, never COMPLETE', () => {
      const pending: AddGuestFlowState = {
        flow: 'AGREGAR',
        step: 'CONFIRM',
        data: { name: 'Juan Perez', phone: '+5491122334455', tickets: 3 },
      };
      const result = advanceFlow(pending, { type: 'CANCEL' });

      expect(result.status).toBe('CANCELLED');
      expect(result).not.toHaveProperty('pending');
    });
  });
});

describe('user-facing wording — neutral tuteo, no voseo', () => {
  // The module deliberately writes Spanish WITHOUT accents/tildes; these
  // assertions pin the tuteo verb forms, not the accentuation.
  const VOSEO_FORMS = /\b(podes|tenes|queres|volve|elegi|envia?nos|anda)\b/i;

  it('rejects an invalid phone with "puedes", not "podes"', () => {
    const pending: AddGuestFlowState = {
      flow: 'AGREGAR',
      step: 'ASK_PHONE',
      data: { name: 'Juan Perez' },
    };
    const result = expectStatus(advanceFlow(pending, { type: 'INPUT', value: 'abc' }), 'INVALID');

    expect(result.message).toContain('puedes incluir +');
    expect(result.message).not.toMatch(VOSEO_FORMS);
  });

  it('rejects an invalid edit field with "Elige", not "Elegi"', () => {
    const pending: EditGuestFlowState = {
      flow: 'EDITAR',
      step: 'PICK_FIELD',
      guestId: 'g-1',
    };
    const result = expectStatus(advanceFlow(pending, { type: 'INPUT', value: 'zzz' }), 'INVALID');

    expect(result.message).toContain('Elige:');
    expect(result.message).not.toMatch(VOSEO_FORMS);
  });

  it('rejects an invalid phone on the EDIT flow with "puedes" too', () => {
    const pending: EditGuestFlowState = {
      flow: 'EDITAR',
      step: 'ASK_VALUE',
      guestId: 'g-1',
      field: 'phone',
    };
    const result = expectStatus(advanceFlow(pending, { type: 'INPUT', value: 'abc' }), 'INVALID');

    expect(result.message).toContain('puedes incluir +');
    expect(result.message).not.toMatch(VOSEO_FORMS);
  });
});
