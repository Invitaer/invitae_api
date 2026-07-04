import { Event } from '../../database/schema';

export interface AssignedUser {
  id: string;
  name: string;
  email: string;
}

export interface EventWithUsers extends Event {
  users: AssignedUser[];
}
