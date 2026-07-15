/**
 * Typed outbound reply descriptor. `WhatsappService` builds one of these per
 * handled inbound message and `handleIncoming` maps it to the matching
 * `WhatsappClient` sender (`sendText` / `sendInteractiveButtons` /
 * `sendInteractiveList`) — never the other way around. This keeps "exactly
 * one outbound message per handled inbound message" enforceable at a single
 * call site while still letting reply builders express interactive replies
 * where the spec requires selection/buttons.
 */

export interface WhatsappReplyButton {
  id: string;
  title: string;
}

export interface WhatsappReplyListRow {
  id: string;
  title: string;
  description?: string;
}

export type WhatsappReply =
  | { kind: 'text'; body: string }
  | { kind: 'buttons'; body: string; buttons: WhatsappReplyButton[] }
  | {
      kind: 'list';
      body: string;
      buttonLabel: string;
      rows: WhatsappReplyListRow[];
    };

export function textReply(body: string): WhatsappReply {
  return { kind: 'text', body };
}

export function buttonsReply(
  body: string,
  buttons: WhatsappReplyButton[],
): WhatsappReply {
  return { kind: 'buttons', body, buttons };
}

export function listReply(
  body: string,
  buttonLabel: string,
  rows: WhatsappReplyListRow[],
): WhatsappReply {
  return { kind: 'list', body, buttonLabel, rows };
}
