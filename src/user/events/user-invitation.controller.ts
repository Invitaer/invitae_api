import { Body, Controller, Get, Param, Put, UseGuards } from '@nestjs/common';
import { Auth } from '../../auth/decorators/authenticated.decorator';
import { CurrentUser } from '../../auth/decorators/current-user.decorator';
import { AuthUser } from '../../auth/interfaces/auth-user.interface';
import { ContentService } from '../../admin/content/content.service';
import { InvitationDto } from '../../admin/content/dto/invitation.dto';
import { UserEventsService } from './user-events.service';
import { UserEventMemberGuard } from './guards/user-event-member.guard';

/**
 * The invitation content of one event, edited by its members from the user
 * dashboard. Same storage and projection as the admin content routes, so the
 * user edits exactly what guests are served.
 */
@Controller('user/events/:id/invitation')
@Auth('user')
export class UserInvitationController {
  constructor(
    private readonly userEventsService: UserEventsService,
    private readonly contentService: ContentService,
  ) {}

  // Method-level on purpose: class guards run first, so the member guard sees
  // `request.user` only once the JWT guard above has set it.
  @Get()
  @UseGuards(UserEventMemberGuard)
  async get(
    @Param('id') id: string,
    @CurrentUser() user: AuthUser,
  ): Promise<InvitationDto> {
    const event = await this.userEventsService.findOne(id, user.id);
    return this.contentService.getInvitation(event);
  }

  @Put()
  @UseGuards(UserEventMemberGuard)
  async replace(
    @Param('id') id: string,
    @CurrentUser() user: AuthUser,
    @Body() dto: InvitationDto,
  ): Promise<InvitationDto> {
    const event = await this.userEventsService.findOne(id, user.id);
    return this.contentService.setInvitation(event, dto);
  }
}
