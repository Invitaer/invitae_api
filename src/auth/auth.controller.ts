import { Controller, Post, Get, Body, UseGuards, HttpCode } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { AuthService } from './auth.service';
import { LoginDto, RegisterDto } from './dtos/auth.dto';
import { CurrentUser } from './decorators/current-user.decorator';
import { AuthUser } from './interfaces/auth-user.interface';

@Controller('auth')
export class AuthController {
  constructor(private authService: AuthService) {}

  @Post('login')
  async login(@Body() dto: LoginDto) {
    return this.authService.login(dto.email, dto.password);
  }

  @Post('register')
  async register(@Body() dto: RegisterDto) {
    return this.authService.register(dto.email, dto.password, dto.name);
  }

  @Get('google')
  @UseGuards(AuthGuard('google'))
  @HttpCode(200)
  googleAuth() {
    // Passport redirects to Google — this handler is never reached
  }

  @Get('google/callback')
  @UseGuards(AuthGuard('google'))
  googleCallback(@CurrentUser() user: AuthUser) {
    return { access_token: this.authService.issueJwt(user) };
  }

  @Get('facebook')
  @UseGuards(AuthGuard('facebook'))
  @HttpCode(200)
  facebookAuth() {
    // Passport redirects to Facebook — this handler is never reached
  }

  @Get('facebook/callback')
  @UseGuards(AuthGuard('facebook'))
  facebookCallback(@CurrentUser() user: AuthUser) {
    return { access_token: this.authService.issueJwt(user) };
  }
}
