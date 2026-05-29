import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import { Event } from '../../../database/schema';

export const CurrentEvent = createParamDecorator(
  (data: unknown, ctx: ExecutionContext): Event | undefined => {
    const request = ctx.switchToHttp().getRequest();
    return request.event;
  },
);
