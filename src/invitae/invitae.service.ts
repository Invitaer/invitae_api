import { Injectable, NotFoundException } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { DatabaseService } from '../database/database.service';
import { Guest, guests } from '../database/schema';
import { RedisService } from '../redis/redis.service';
import { InvitationDto } from '../admin/content/dto/invitation.dto';
import { ConfirmAttendanceDto } from './dto/confirm-attendance.dto';

@Injectable()
export class InvitaeService {
  private readonly INV_IDX_PREFIX = 'inv_idx:';

  constructor(
    private readonly databaseService: DatabaseService,
    private readonly redisService: RedisService,
  ) {}

  async confirmAttendance(dto: ConfirmAttendanceDto): Promise<Guest> {
    const [guest] = await this.databaseService.db
      .update(guests)
      .set({
        attendanceConfirmed: dto.attending,
        updatedAt: new Date(),
      })
      .where(eq(guests.id, dto.guestId))
      .returning();

    if (!guest) throw new NotFoundException(`Guest ${dto.guestId} not found`);
    return guest;
  }

  async getInvitation(slug: string): Promise<InvitationDto> {
    const userId = await this.redisService.get(`${this.INV_IDX_PREFIX}${slug}`);
    if (!userId) throw new NotFoundException(`Invitation '${slug}' not found`);
    const raw = await this.redisService.get(`user.${userId}:invitation`);
    if (!raw) throw new NotFoundException(`Invitation '${slug}' not found`);
    return JSON.parse(raw) as InvitationDto;
  }
}
