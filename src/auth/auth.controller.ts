import {
  Controller,
  Post,
  Get,
  Body,
  UseGuards,
  HttpCode,
  Logger,
  Query,
  Res,
} from "@nestjs/common";
import { AuthGuard } from "@nestjs/passport";
import type { Response } from "express";
import { AuthService } from "./auth.service";
import { LoginDto, RegisterDto, ResendVerificationDto } from "./dtos/auth.dto";
import { EmailVerificationService } from "./email-verification.service";
import { CurrentUser } from "./decorators/current-user.decorator";
import { AuthUser } from "./interfaces/auth-user.interface";
import { Auth } from "./decorators/authenticated.decorator";
import type { Audience } from "./audience";
import { isAdminRole } from "./admin-roles";
import {
  authCookieName,
  authCookieOptions,
  clearAuthCookieOptions,
} from "./auth-cookie";

/**
 * Every session-bearing route is scoped to ONE application.
 *
 * The two dashboards share a host in development (`localhost`, different
 * ports) and cookies ignore ports, so a single `/auth/login` writing a single
 * cookie name meant one browser could only ever hold one session. Splitting
 * the routes by audience is what lets an admin and a test user be signed in
 * side by side.
 */
@Controller("auth")
export class AuthController {
  private readonly dashboardUrl =
    process.env.DASHBOARD_URL ?? "http://localhost:8090";

  private readonly userDashboardUrl =
    process.env.USER_DASHBOARD_URL ?? "http://localhost:8091";

  constructor(
    private authService: AuthService,
    private emailVerificationService: EmailVerificationService,
  ) {}

  // --- Admin dashboard session ---

  @Post("admin/login")
  async adminLogin(
    @Body() dto: LoginDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    return this.completePasswordLogin(dto, res, "admin");
  }

  @Post("admin/logout")
  @HttpCode(200)
  adminLogout(@Res({ passthrough: true }) res: Response) {
    return this.completeLogout(res, "admin");
  }

  @Get("admin/me")
  @Auth("admin")
  adminMe(@CurrentUser() user: AuthUser) {
    return { id: user.id, email: user.email, name: user.name, role: user.role };
  }

  // --- User dashboard session ---

  @Post("user/login")
  async userLogin(
    @Body() dto: LoginDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    return this.completePasswordLogin(dto, res, "user");
  }

  @Post("user/logout")
  @HttpCode(200)
  userLogout(@Res({ passthrough: true }) res: Response) {
    return this.completeLogout(res, "user");
  }

  @Get("user/me")
  @Auth("user")
  userMe(@CurrentUser() user: AuthUser) {
    return { id: user.id, email: user.email, name: user.name };
  }

  // --- Shared, session-free routes ---

  @Post("register")
  async register(@Body() dto: RegisterDto) {
    return this.authService.register(dto.email, dto.password, dto.name);
  }

  /**
   * Landing point for the link in the confirmation email. Arrives as a
   * top-level navigation from a mail client with no session and no JS, so it
   * must be a plain GET that answers with a redirect — never JSON, which the
   * user would see raw.
   *
   * Both outcomes redirect to the same page and differ only in the flag, so
   * the dashboard owns all the wording.
   */
  @Get("verify-email")
  async verifyEmail(
    @Query("token") token: string | undefined,
    @Res() res: Response,
  ) {
    const verified = !!token && (await this.emailVerificationService.verify(token));
    return res.redirect(
      `${this.userDashboardUrl}/login?verified=${verified ? "1" : "0"}`,
    );
  }

  /**
   * Escape hatch for whoever never received (or let expire) their link. It has
   * to be unauthenticated by definition — the user cannot log in yet — which
   * makes it two things at once: a user-enumeration oracle and a free mailer.
   *
   * Both are closed here: the response is a constant 202 regardless of whether
   * the address exists, and `claimResendSlot` caps one send per address per
   * cooldown window.
   */
  @Post("resend-verification")
  @HttpCode(202)
  async resendVerification(@Body() dto: ResendVerificationDto) {
    if (await this.emailVerificationService.claimResendSlot(dto.email)) {
      await this.emailVerificationService.resendTo(dto.email);
    }

    // Deliberately says nothing about what happened.
    return {
      message:
        "Si esa direccion tiene una cuenta sin confirmar, te enviamos un correo.",
    };
  }

  // --- Admin dashboard OAuth routes ---

  @Get("google")
  @UseGuards(AuthGuard("google"))
  @HttpCode(200)
  googleAuth() {
    // Passport redirects to Google — this handler is never reached
  }

  @Get("google/callback")
  @UseGuards(AuthGuard("google"))
  googleCallback(@CurrentUser() user: AuthUser, @Res() res: Response) {
    return this.completeOAuthLogin(user, res, "google", "admin");
  }

  @Get("facebook")
  @UseGuards(AuthGuard("facebook"))
  @HttpCode(200)
  facebookAuth() {
    // Passport redirects to Facebook — this handler is never reached
  }

  @Get("facebook/callback")
  @UseGuards(AuthGuard("facebook"))
  facebookCallback(@CurrentUser() user: AuthUser, @Res() res: Response) {
    return this.completeOAuthLogin(user, res, "facebook", "admin");
  }

  // --- User dashboard OAuth routes ---

  @Get("google/user")
  @UseGuards(AuthGuard("google-user"))
  @HttpCode(200)
  googleUserAuth() {
    // Passport redirects to Google — this handler is never reached
  }

  @Get("google/user/callback")
  @UseGuards(AuthGuard("google-user"))
  googleUserCallback(@CurrentUser() user: AuthUser, @Res() res: Response) {
    return this.completeOAuthLogin(user, res, "google", "user");
  }

  @Get("facebook/user")
  @UseGuards(AuthGuard("facebook-user"))
  @HttpCode(200)
  facebookUserAuth() {
    // Passport redirects to Facebook — this handler is never reached
  }

  @Get("facebook/user/callback")
  @UseGuards(AuthGuard("facebook-user"))
  facebookUserCallback(@CurrentUser() user: AuthUser, @Res() res: Response) {
    return this.completeOAuthLogin(user, res, "facebook", "user");
  }

  private async completePasswordLogin(
    dto: LoginDto,
    res: Response,
    audience: Audience,
  ) {
    Logger.debug(`Login attempt for email: ${dto.email} (${audience})`);
    const result = await this.authService.login(
      dto.email,
      dto.password,
      audience,
    );

    // The token is never returned in the body. It lives only in an httpOnly
    // cookie, so no XSS on either dashboard can read or exfiltrate it.
    res.cookie(authCookieName(audience), result.token, authCookieOptions());

    return { user: result.user };
  }

  /**
   * An httpOnly cookie is unreachable from JS, so signing out has to happen
   * server-side — the client cannot clear it on its own. Only the cookie for
   * THIS application is cleared: signing out of the admin panel must not end
   * the user-dashboard session in the next tab.
   */
  private completeLogout(res: Response, audience: Audience) {
    res.clearCookie(authCookieName(audience), clearAuthCookieOptions());
    return { success: true };
  }

  /**
   * Sets the session cookie on THIS origin and redirects with a clean URL.
   *
   * The OAuth callback is a top-level navigation to the API, so the API can
   * write the cookie itself. That removes the `?token=` hand-off entirely —
   * it used to park a 7-day JWT in browser history, the Referer header and
   * every proxy access log between here and the dashboard.
   */
  private completeOAuthLogin(
    user: AuthUser,
    res: Response,
    provider: "google" | "facebook",
    audience: Audience,
  ) {
    const dashboardUrl =
      audience === "admin" ? this.dashboardUrl : this.userDashboardUrl;

    // OAuth signs up whoever shows up with a valid Google/Facebook account, so
    // without this check the admin flow would mint an admin-audience token for
    // any stranger. `JwtAdminStrategy` would still refuse them on every
    // request, but issuing the token at all is a trap waiting for someone to
    // relax that check.
    if (audience === "admin" && !isAdminRole(user.role)) {
      return res.redirect(`${dashboardUrl}/login?error=forbidden`);
    }

    const token = this.authService.issueJwt(user, audience);
    res.cookie(authCookieName(audience), token, authCookieOptions());
    return res.redirect(`${dashboardUrl}/api/auth/callback/${provider}`);
  }
}
