import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { RedisService } from '../../redis/redis.service';
import { Event } from '../../database/schema';
import { projectInvitation } from '../../invitae/invitation.projection';
import { InvitationDto } from './dto/invitation.dto';

@Injectable()
export class ContentService {
  private readonly CONTENT_PREFIX = 'content:';

  constructor(private readonly redisService: RedisService) {}

  private invKey(eventId: string): string {
    return `event:${eventId}:invitation`;
  }

  private originalKey(eventId: string): string {
    return `${this.invKey(eventId)}:original`;
  }

  private contentKey(eventId: string, key: string): string {
    return `${this.CONTENT_PREFIX}${eventId}:${key}`;
  }

  async getAllKeys(eventId: string): Promise<string[]> {
    const prefix = `${this.CONTENT_PREFIX}${eventId}:`;
    const keys = await this.redisService.client.keys(`${prefix}*`);
    return keys.map((k) => k.replace(prefix, ''));
  }

  async getContent(eventId: string, key: string): Promise<{ key: string; value: string | null }> {
    const value = await this.redisService.get(this.contentKey(eventId, key));
    return { key, value };
  }

  async setContent(eventId: string, key: string, value: string): Promise<{ key: string; value: string }> {
    await this.redisService.set(this.contentKey(eventId, key), value);
    return { key, value };
  }

  async deleteContent(eventId: string, key: string): Promise<void> {
    await this.redisService.del(this.contentKey(eventId, key));
  }

  /**
   * The public URL of an invitation is owned by `events.slug` (unique at the DB
   * level), never by the request body. A client-supplied slug is overwritten, not
   * honored — otherwise event B could claim event A's public URL.
   */
  async setInvitation(event: Event, dto: InvitationDto): Promise<InvitationDto> {
    dto.metadata.slug = event.slug;
    dto.metadata.eventType = event.eventType;
    const value = JSON.stringify(dto);

    // The original is whatever the invitation held first: content stored before
    // the snapshot existed wins over this edit, and NX never replaces one.
    const previous = await this.redisService.get(this.invKey(event.id));
    await this.redisService.client.set(this.originalKey(event.id), previous ?? value, 'NX');

    await this.redisService.set(this.invKey(event.id), value);
    Logger.log(`setInvitation: eventId=${event.id} slug=${event.slug}`);
    return dto;
  }

  /**
   * Projected on read, exactly like the public endpoint, so the editor preview
   * always shows what guests will actually see.
   */
  async getInvitation(event: Event): Promise<InvitationDto> {
    const raw = await this.redisService.get(this.invKey(event.id));
    if (!raw) throw new NotFoundException(`Invitation for event '${event.id}' not found`);
    return projectInvitation(JSON.parse(raw) as InvitationDto, event);
  }

  /** The invitation as first stored, projected like the live one; used to reset an edit. */
  async getOriginalInvitation(event: Event): Promise<InvitationDto> {
    const raw = await this.redisService.get(this.originalKey(event.id));
    if (!raw) throw new NotFoundException(`Original invitation for event '${event.id}' not found`);
    return projectInvitation(JSON.parse(raw) as InvitationDto, event);
  }

  async deleteInvitation(eventId: string): Promise<void> {
    await this.redisService.del(this.invKey(eventId));
  }
}
