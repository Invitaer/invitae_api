import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  Query,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Response } from 'express';
import { Auth } from '../auth/decorators/authenticated.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { AuthUser } from '../auth/interfaces/auth-user.interface';
import { secrets } from '../config/secrets';
import { WhatsappSignatureGuard } from './guards/whatsapp-signature.guard';
import { WhatsappLinkService } from './whatsapp-link.service';
import { WhatsappService, WhatsappWebhookPayload } from './whatsapp.service';

@Controller('whatsapp')
export class WhatsappController {
  constructor(
    private readonly whatsappService: WhatsappService,
    private readonly whatsappLinkService: WhatsappLinkService,
  ) {}

  @Get('webhook')
  verify(
    @Query('hub.mode') mode: string,
    @Query('hub.verify_token') verifyToken: string,
    @Query('hub.challenge') challenge: string,
    @Res() res: Response,
  ): Response {
    if (verifyToken === secrets.WHATSAPP_VERIFY_TOKEN) {
      return res.status(HttpStatus.OK).send(challenge);
    }
    return res.status(HttpStatus.FORBIDDEN).send();
  }

  @Post('webhook')
  @HttpCode(HttpStatus.OK)
  @UseGuards(WhatsappSignatureGuard)
  async receive(@Body() payload: WhatsappWebhookPayload): Promise<{ status: string }> {
    await this.whatsappService.handleIncoming(payload);
    return { status: 'ok' };
  }

  @Post('link/start')
  @Auth()
  startLink(@CurrentUser() user: AuthUser): Promise<{ delivered: true; email: string }> {
    return this.whatsappLinkService.startLink(user.id, user.email);
  }
}
