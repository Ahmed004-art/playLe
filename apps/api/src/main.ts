import { Logger, ValidationPipe, VersioningType } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import { AppModule } from './app.module.js';
import type { AppConfiguration } from './config/configuration.js';
import { GlobalExceptionFilter } from './common/filters/http-exception.filter.js';

async function bootstrap(): Promise<void> {
  // `rawBody: true` preserves the raw request bytes (`req.rawBody`) needed
  // to verify a payment provider's webhook signature — see
  // src/deposits/webhooks.controller.ts. Nothing else in the app uses it.
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    rawBody: true,
  });
  const configService = app.get(ConfigService<AppConfiguration, true>);

  const port = configService.get('port', { infer: true });
  const corsOrigins = configService.get('corsOrigins', { infer: true });
  const env = configService.get('env', { infer: true });

  // Behind an HTTPS load balancer, `req.ip` (rate limits, audit logs) must
  // come from X-Forwarded-For, trusting exactly the configured hops.
  const trustProxyHops = configService.get('trustProxyHops', { infer: true });
  if (trustProxyHops > 0) app.set('trust proxy', trustProxyHops);

  app.use(helmet());
  // Needed to read the httpOnly admin-session cookies (see
  // src/admin-auth/) — `req.cookies` is otherwise undefined.
  app.use(cookieParser());
  app.enableCors({ origin: corsOrigins, credentials: true });

  app.setGlobalPrefix('api');
  app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );
  app.useGlobalFilters(new GlobalExceptionFilter());

  const swaggerEnabled = configService.get('swaggerEnabled', { infer: true });
  if (swaggerEnabled) {
    const swaggerConfig = new DocumentBuilder()
      .setTitle('PlayLe API')
      .setDescription('PlayLe backend API — Phase 1 foundation.')
      .setVersion('1.0')
      .build();
    const swaggerDocument = SwaggerModule.createDocument(app, swaggerConfig);
    SwaggerModule.setup('api/docs', app, swaggerDocument);
  }

  app.enableShutdownHooks();

  await app.listen(port);

  Logger.log(`PlayLe API listening on port ${port} [${env}]`, 'Bootstrap');
  if (swaggerEnabled) {
    Logger.log(`Swagger docs available at /api/docs`, 'Bootstrap');
  }
}

await bootstrap();
