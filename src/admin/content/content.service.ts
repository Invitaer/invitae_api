import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { RedisService } from '../../redis/redis.service';
import { InvitationDto } from './dto/invitation.dto';

@Injectable()
export class ContentService {
  private readonly PREFIX = 'content:';
  private readonly INV_IDX_PREFIX = 'inv_idx:';

  constructor(private readonly redisService: RedisService) {}

  private invKey(userId: string): string {
    return `user.${userId}:invitation`;
  }

  async getAllKeys(): Promise<string[]> {
    const keys = await this.redisService.client.keys(`${this.PREFIX}*`);
    return keys.map((k) => k.replace(this.PREFIX, ''));
  }

  async getContent(key: string): Promise<{ key: string; value: string | null }> {
    const value = await this.redisService.get(`${this.PREFIX}${key}`);
    return { key, value };
  }

  async setContent(key: string, value: string): Promise<{ key: string; value: string }> {
    await this.redisService.set(`${this.PREFIX}${key}`, value);
    return { key, value };
  }

  async deleteContent(key: string): Promise<void> {
    await this.redisService.del(`${this.PREFIX}${key}`);
  }

  async setInvitation(userId: string, dto: InvitationDto): Promise<InvitationDto> {
    const newSlug = dto.metadata.slug;

    // If the user already has an invitation with a different slug, remove the old index
    const existing = await this.redisService.get(this.invKey(userId));
    if (existing) {
      const oldSlug = (JSON.parse(existing) as InvitationDto).metadata.slug;
      if (oldSlug !== newSlug) {
        await this.redisService.del(`${this.INV_IDX_PREFIX}${oldSlug}`);
      }
    }

    await this.redisService.set(this.invKey(userId), JSON.stringify(dto));
    await this.redisService.set(`${this.INV_IDX_PREFIX}${newSlug}`, userId);
    Logger.log(`setInvitation: userId=${userId} slug=${newSlug}`);
    return dto;
  }

  async getInvitation(userId: string): Promise<InvitationDto> {
    const raw = await this.redisService.get(this.invKey(userId));
    if (!raw) throw new NotFoundException(`Invitation for user '${userId}' not found`);
    return JSON.parse(raw) as InvitationDto;
  }

  async deleteInvitation(userId: string): Promise<void> {
    const raw = await this.redisService.get(this.invKey(userId));
    if (raw) {
      const slug = (JSON.parse(raw) as InvitationDto).metadata.slug;
      await this.redisService.del(`${this.INV_IDX_PREFIX}${slug}`);
    }
    await this.redisService.del(this.invKey(userId));
  }
}
