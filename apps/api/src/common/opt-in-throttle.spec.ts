import 'reflect-metadata';
import { Controller, Get, Post, type INestApplication } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { Throttle, ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import request from 'supertest';
import { afterAll, beforeAll, describe, it } from 'vitest';

import { optInThrottleSkipIf } from './opt-in-throttle.js';

// Production-like: auth allows 2 requests/minute here (5 in production).
@Controller('t')
class TestController {
  @Get('plain')
  plain(): string {
    return 'ok';
  }

  @Post('login')
  @Throttle({ auth: {} })
  login(): string {
    return 'ok';
  }
}

describe('opt-in named throttlers', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        ThrottlerModule.forRoot({
          throttlers: [
            { name: 'default', ttl: 60_000, limit: 1000 },
            {
              name: 'auth',
              ttl: 60_000,
              limit: 2,
              skipIf: optInThrottleSkipIf('auth'),
            },
          ],
        }),
      ],
      controllers: [TestController],
      providers: [{ provide: APP_GUARD, useClass: ThrottlerGuard }],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
  }, 60_000);

  afterAll(async () => {
    await app.close();
  });

  it('does not apply the auth limit to an ordinary route', async () => {
    for (let i = 0; i < 6; i++) {
      await request(app.getHttpServer()).get('/t/plain').expect(200);
    }
  });

  it('still applies the auth limit to a route that opts in', async () => {
    await request(app.getHttpServer()).post('/t/login').expect(201);
    await request(app.getHttpServer()).post('/t/login').expect(201);
    await request(app.getHttpServer()).post('/t/login').expect(429);
  });
});
