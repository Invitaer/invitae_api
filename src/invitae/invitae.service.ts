import { Injectable, NotFoundException } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { DatabaseService } from '../database/database.service';
import { Guest, guests } from '../database/schema';
import { ConfirmAttendanceDto } from './dto/confirm-attendance.dto';

@Injectable()
export class InvitaeService {
  constructor(private readonly databaseService: DatabaseService) {}

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
}
