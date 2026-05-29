import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { RedisService } from '../../redis/redis.service';
import { InvitationDto } from './dto/invitation.dto';

@Injectable()
export class ContentService {
  private readonly CONTENT_PREFIX = 'content:';
  private readonly INV_IDX_PREFIX = 'inv_idx:';

  constructor(private readonly redisService: RedisService) {}

  private invKey(eventId: string): string {
    return `event:${eventId}:invitation`;
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

  async setInvitation(eventId: string, dto: InvitationDto): Promise<InvitationDto> {
    const newSlug = dto.metadata.slug;

    // If the event already has an invitation with a different slug, remove the old index
    const existing = await this.redisService.get(this.invKey(eventId));
    if (existing) {
      const oldSlug = (JSON.parse(existing) as InvitationDto).metadata.slug;
      if (oldSlug !== newSlug) {
        await this.redisService.del(`${this.INV_IDX_PREFIX}${oldSlug}`);
      }
    }

    await this.redisService.set(this.invKey(eventId), JSON.stringify(dto));
    await this.redisService.set(`${this.INV_IDX_PREFIX}${newSlug}`, eventId);
    Logger.log(`setInvitation: eventId=${eventId} slug=${newSlug}`);
    return dto;
  }

  async getInvitation(eventId: string): Promise<InvitationDto> {
    const raw = await this.redisService.get(this.invKey(eventId));
    if (!raw) throw new NotFoundException(`Invitation for event '${eventId}' not found`);
    return JSON.parse(raw) as InvitationDto;
  }

  async deleteInvitation(eventId: string): Promise<void> {
    const raw = await this.redisService.get(this.invKey(eventId));
    if (raw) {
      const slug = (JSON.parse(raw) as InvitationDto).metadata.slug;
      await this.redisService.del(`${this.INV_IDX_PREFIX}${slug}`);
    }
    await this.redisService.del(this.invKey(eventId));
  }
}
