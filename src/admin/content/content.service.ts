import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { RedisService } from '../../redis/redis.service';
import { InvitationDto } from './dto/invitation.dto';

@Injectable()
export class ContentService {
  private readonly PREFIX = 'content:';
  private readonly INV_PREFIX = 'invitation:';

  constructor(private readonly redisService: RedisService) {}

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

  async setInvitation(dto: InvitationDto): Promise<InvitationDto> {
    const slug = dto.metadata.slug;
    await this.redisService.set(`${this.INV_PREFIX}${slug}`, JSON.stringify(dto));
    return dto;
  }

  async getInvitation(slug: string): Promise<InvitationDto> {
    const raw = await this.redisService.get(`${this.INV_PREFIX}${slug}`);
    Logger.log(`getInvitation: slug=${slug}, raw=${raw}`);
    if (!raw) throw new NotFoundException(`Invitation '${slug}' not found`);
    return JSON.parse(raw) as InvitationDto;
  }

  async deleteInvitation(slug: string): Promise<void> {
    await this.redisService.del(`${this.INV_PREFIX}${slug}`);
  }
}
