import { parseCommand } from './command.parser';
import { BotIntent } from './bot-intent';

describe('parseCommand', () => {
  const cases: Array<{
    description: string;
    input: { text?: string; interactiveId?: string };
    expected: BotIntent;
  }> = [
    {
      description: 'text "menu" -> MENU',
      input: { text: 'menu' },
      expected: { kind: 'MENU' },
    },
    {
      description: 'text "help" -> MENU',
      input: { text: 'help' },
      expected: { kind: 'MENU' },
    },
    {
      description: 'text "ayuda" -> MENU',
      input: { text: 'ayuda' },
      expected: { kind: 'MENU' },
    },
    {
      description: 'button reply id "menu" -> MENU',
      input: { interactiveId: 'menu' },
      expected: { kind: 'MENU' },
    },
    {
      description: 'text "mis eventos" -> LIST_EVENTS',
      input: { text: 'mis eventos' },
      expected: { kind: 'LIST_EVENTS' },
    },
    {
      description: 'text "eventos" -> LIST_EVENTS',
      input: { text: 'eventos' },
      expected: { kind: 'LIST_EVENTS' },
    },
    {
      description: 'list reply id "list_events" -> LIST_EVENTS',
      input: { interactiveId: 'list_events' },
      expected: { kind: 'LIST_EVENTS' },
    },
    {
      description: 'list reply id "select_event:evt-123" -> SELECT_EVENT (no free-text NLP)',
      input: { interactiveId: 'select_event:evt-123' },
      expected: { kind: 'SELECT_EVENT', eventId: 'evt-123' },
    },
    {
      description: 'free text "seleccionar evento" alone is NOT a valid select (button/list only)',
      input: { text: 'seleccionar evento' },
      expected: { kind: 'UNKNOWN' },
    },
    {
      description: 'text "detalle" -> EVENT_DETAIL',
      input: { text: 'detalle' },
      expected: { kind: 'EVENT_DETAIL' },
    },
    {
      description: 'button reply id "detalle" -> EVENT_DETAIL',
      input: { interactiveId: 'detalle' },
      expected: { kind: 'EVENT_DETAIL' },
    },
    {
      description: 'text "buscar Juan Perez" -> SEARCH_GUEST term="Juan Perez"',
      input: { text: 'buscar Juan Perez' },
      expected: { kind: 'SEARCH_GUEST', term: 'Juan Perez' },
    },
    {
      description: 'text "status Maria" -> SEARCH_GUEST term="Maria" (alias)',
      input: { text: 'status Maria' },
      expected: { kind: 'SEARCH_GUEST', term: 'Maria' },
    },
    {
      description: 'text "filtrar confirmados" -> FILTER_BY_STATUS ACCEPTED',
      input: { text: 'filtrar confirmados' },
      expected: { kind: 'FILTER_BY_STATUS', status: 'ACCEPTED' },
    },
    {
      description: 'text "filtrar pendientes" -> FILTER_BY_STATUS PENDING',
      input: { text: 'filtrar pendientes' },
      expected: { kind: 'FILTER_BY_STATUS', status: 'PENDING' },
    },
    {
      description: 'text "filtrar rechazados" -> FILTER_BY_STATUS DECLINED',
      input: { text: 'filtrar rechazados' },
      expected: { kind: 'FILTER_BY_STATUS', status: 'DECLINED' },
    },
    {
      description: 'button reply id "filter:confirmados" -> FILTER_BY_STATUS ACCEPTED',
      input: { interactiveId: 'filter:confirmados' },
      expected: { kind: 'FILTER_BY_STATUS', status: 'ACCEPTED' },
    },
    {
      description: 'text "resumen" -> RSVP_SUMMARY',
      input: { text: 'resumen' },
      expected: { kind: 'RSVP_SUMMARY' },
    },
    {
      description: 'text "cancelar" -> CANCEL',
      input: { text: 'cancelar' },
      expected: { kind: 'CANCEL' },
    },
    {
      description: 'button reply id "cancel" -> CANCEL',
      input: { interactiveId: 'cancel' },
      expected: { kind: 'CANCEL' },
    },
    {
      description: 'gibberish text -> UNKNOWN',
      input: { text: 'blah blah nonsense' },
      expected: { kind: 'UNKNOWN' },
    },
    {
      description: 'empty input -> UNKNOWN',
      input: {},
      expected: { kind: 'UNKNOWN' },
    },
    {
      description: 'text is case-insensitive and trimmed: "  MENU  " -> MENU',
      input: { text: '  MENU  ' },
      expected: { kind: 'MENU' },
    },
  ];

  it.each(cases)('$description', ({ input, expected }) => {
    expect(parseCommand(input)).toEqual(expected);
  });

  it('prioritizes interactiveId over text when both are present', () => {
    expect(parseCommand({ text: 'blah', interactiveId: 'menu' })).toEqual({
      kind: 'MENU',
    });
  });
});
