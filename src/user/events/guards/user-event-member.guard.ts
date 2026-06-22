import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from "@nestjs/common";
import { and, eq } from "drizzle-orm";
import { DatabaseService } from "../../../database/database.service";
import { eventUsers } from "../../../database/schema";

@Injectable()
export class UserEventMemberGuard implements CanActivate {
  constructor(private readonly databaseService: DatabaseService) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const request = ctx.switchToHttp().getRequest();
    const eventId: string = request.params.id;
    const [membership] = await this.databaseService.db
      .select()
      .from(eventUsers)
      .where(
        and(
          eq(eventUsers.eventId, eventId),
          eq(eventUsers.userId, request.user.id),
        ),
      );

    if (!membership) {
      throw new ForbiddenException("You are not a member of this event");
    }

    return true;
  }
}
