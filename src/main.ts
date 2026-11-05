import './config/env-loader';
import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import * as cookieParser from 'cookie-parser';
import { AppModule } from './app.module';
import { secrets } from './config/secrets';

/**
 * Origins allowed to send credentials. `Access-Control-Allow-Origin: *` is
 * INVALID together with credentials, so once cookies are in play the allow-list
 * has to be explicit — a wildcard makes the browser reject every response.
 */
function corsOrigins(): string[] {
  return [
    secrets.DASHBOARD_URL ?? 'http://localhost:8090',
    secrets.USER_DASHBOARD_URL ?? 'http://localhost:8091',
    secrets.INVITATION_URL ?? 'http://localhost:8095',
  ];
}

async function bootstrap() {
  const app = await NestFactory.create(AppModule, { rawBody: true });

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
      forbidNonWhitelisted: true,
    }),
  );

  // Required before the jwt strategy can read the session cookie: Nest does
  // not populate `req.cookies` on its own.
  app.use(cookieParser());

  app.enableCors({ origin: corsOrigins(), credentials: true });

  const port = parseInt(secrets.PORT, 10) || 3000;
  await app.listen(port);
  console.log(`Invitae API running on port ${port}`);
}

bootstrap();
