import './config/env-loader';
import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { AppModule } from './app.module';
import { secrets } from './config/secrets';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, { rawBody: true });

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
      forbidNonWhitelisted: true,
    }),
  );

  app.enableCors();

  const port = parseInt(secrets.PORT, 10) || 3000;
  await app.listen(port);
  console.log(`Invitae API running on port ${port}`);
}

bootstrap();
