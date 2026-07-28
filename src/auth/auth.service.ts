import {
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from "@nestjs/common";
import { JwtService } from "@nestjs/jwt";
import { DatabaseService } from "../database/database.service";
import { CryptoService } from "../crypto/crypto.service";
import { users } from "../database/schema/users.schema";
import { EmailVerificationService } from "./email-verification.service";
import type { Audience } from "./audience";
import { isAdminRole } from "./admin-roles";
import { eq } from "drizzle-orm";

@Injectable()
export class AuthService {
  constructor(
    private dbService: DatabaseService,
    private jwtService: JwtService,
    private cryptoService: CryptoService,
    private emailVerificationService: EmailVerificationService,
  ) {}

  async validateUser(email: string, password: string): Promise<any> {
    const [user] = await this.dbService.db
      .select()
      .from(users)
      .where(eq(users.email, email));

    if (!user) {
      return null;
    }

    if (!user.password) {
      throw new UnauthorizedException("Use social login");
    }

    const comparison = await this.cryptoService.compare(
      password,
      user.password,
    );

    if (!comparison) {
      return null;
    }

    const { password: _, ...result } = user;
    return result;
  }

  /**
   * `aud` marks which application the token was minted for. Without it a
   * session is just "signed in somewhere", and a token taken from one
   * dashboard opens the other.
   */
  issueJwt(
    user: { id: string; email: string; name: string },
    audience: Audience,
  ): string {
    return this.jwtService.sign({
      sub: user.id,
      email: user.email,
      name: user.name,
      aud: audience,
    });
  }

  async login(email: string, password: string, audience: Audience) {
    const user = await this.validateUser(email, password);

    if (!user) {
      throw new UnauthorizedException("Invalid credentials");
    }

    // Checked AFTER the password, never before: answering 403 to a bad
    // password would tell an attacker that the address is registered but
    // unconfirmed. Wrong credentials must look identical either way.
    if (!user.emailVerifiedAt) {
      throw new ForbiddenException(
        "Confirma tu correo antes de iniciar sesion. Revisa tu bandeja de entrada.",
      );
    }

    // Refused at the door rather than at every admin route: an admin-audience
    // token in the hands of a non-admin should never exist in the first place.
    // The strategy re-checks the role on every request anyway, in case it is
    // revoked while a token is still alive.
    if (audience === "admin" && !isAdminRole(user.role)) {
      throw new ForbiddenException(
        "Esta cuenta no tiene acceso al panel de administracion.",
      );
    }

    return {
      token: this.issueJwt(user, audience),
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
      },
    };
  }

  async register(email: string, password: string, name: string) {
    const hashedPassword = await this.cryptoService.hash(password);
    const [user] = await this.dbService.db
      .insert(users)
      .values({ email, password: hashedPassword, name })
      .returning();

    // The row is already committed, so a delivery failure must NOT fail the
    // request — that would report "signup failed" for an account that exists,
    // and the retry would collide with the unique email constraint.
    // `sendFor` returns an outcome instead of throwing; whoever never gets the
    // mail recovers through `POST /auth/resend-verification`.
    await this.emailVerificationService.sendFor({
      id: user.id,
      email: user.email,
      name: user.name,
    });

    const { password: _, ...result } = user;
    return result;
  }
}
