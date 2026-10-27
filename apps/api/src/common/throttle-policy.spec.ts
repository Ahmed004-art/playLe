import 'reflect-metadata';
import {
  Controller,
  Post,
  Req,
  type INestApplication,
  type Type,
} from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { AdminSessionController } from '../admin-auth/admin-session.controller.js';
import { AuthController } from '../auth/auth.controller.js';
import { ChallengesController } from '../challenges/challenges.controller.js';
import { DepositsController } from '../deposits/deposits.controller.js';
import { WebhooksController } from '../deposits/webhooks.controller.js';
import { MatchesController } from '../matches/matches.controller.js';
import { MatchmakingController } from '../matchmaking/matchmaking.controller.js';
import { MfaController } from '../mfa/mfa.controller.js';
import { WithdrawalsController } from '../withdrawals/withdrawals.controller.js';
import { optInThrottleSkipIf } from './opt-in-throttle.js';

/**
 * Throttle policy (Phase 13). Each named throttler (`auth`, `payments`,
 * `matches`, `stakes`) is opt-in: a route is limited by it only if it carries
 * `@Throttle({ <name>: {} })`. These tests read that metadata from the real
 * controllers, so adding a sensitive route without a decorator, or removing one
 * from an existing route, fails here.
 */
function limitedBy(
  controller: Type<unknown>,
  handler: string,
  name: string,
): boolean {
  const fn = (controller.prototype as Record<string, unknown>)[handler];
  if (typeof fn !== 'function') {
    throw new Error(`${controller.name}.${handler} does not exist`);
  }
  return (
    Reflect.hasMetadata(`THROTTLER:LIMIT${name}`, fn) ||
    Reflect.hasMetadata(`THROTTLER:LIMIT${name}`, controller)
  );
}

describe('named throttler policy per route', () => {
  const sensitive: Array<[Type<unknown>, string, string]> = [
    [AuthController, 'register', 'auth'],
    [AuthController, 'login', 'auth'],
    [AuthController, 'verifyMfa', 'auth'],
    [AuthController, 'refresh', 'auth'],
    [AuthController, 'changePassword', 'auth'],
    [MfaController, 'enroll', 'auth'],
    [MfaController, 'confirm', 'auth'],
    [MfaController, 'disable', 'auth'],
    [AdminSessionController, 'login', 'auth'],
    [AdminSessionController, 'verifyMfa', 'auth'],
    [AdminSessionController, 'refresh', 'auth'],
    [ChallengesController, 'create', 'matches'],
    [ChallengesController, 'accept', 'matches'],
    [ChallengesController, 'decline', 'matches'],
    [ChallengesController, 'cancel', 'matches'],
    [MatchmakingController, 'join', 'matches'],
    [MatchmakingController, 'leave', 'matches'],
    [MatchesController, 'submitCommand', 'matches'],
    [MatchesController, 'confirmStake', 'matches'],
    [DepositsController, 'create', 'payments'],
    [WithdrawalsController, 'create', 'payments'],
    [WithdrawalsController, 'cancel', 'payments'],
  ];

  it.each(sensitive)(
    '%o.%s keeps its explicit %s limit',
    (controller, handler, name) => {
      expect(limitedBy(controller, handler, name)).toBe(true);
    },
  );

  const unlimited: Array<[Type<unknown>, string]> = [
    [AuthController, 'logout'],
    [MatchesController, 'list'],
    [MatchesController, 'findOne'],
    [MatchesController, 'financial'],
    [ChallengesController, 'list'],
    [DepositsController, 'list'],
    [DepositsController, 'findOne'],
    [WithdrawalsController, 'list'],
    [WithdrawalsController, 'findOne'],
    [MfaController, 'status'],
    [WebhooksController, 'handle'],
  ];

  it.each(unlimited)(
    '%o.%s is not subject to any opt-in named limit',
    (controller, handler) => {
      for (const name of ['auth', 'payments', 'matches', 'stakes']) {
        expect(limitedBy(controller, handler, name)).toBe(false);
      }
    },
  );
});

// A stand-in with the webhook's shape (unauthenticated POST, always 200),
// mounted under production-like limits.
@Controller('hook')
class WebhookLikeController {
  @Post()
  handle(@Req() _req: unknown): { status: string } {
    return { status: 'ok' };
  }
}

describe('webhook-style delivery under production-like limits', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        ThrottlerModule.forRoot({
          throttlers: [
            { name: 'default', ttl: 60_000, limit: 100 },
            {
              name: 'auth',
              ttl: 60_000,
              limit: 5,
              skipIf: optInThrottleSkipIf('auth'),
            },
            {
              name: 'payments',
              ttl: 60_000,
              limit: 10,
              skipIf: optInThrottleSkipIf('payments'),
            },
          ],
        }),
      ],
      controllers: [WebhookLikeController],
      providers: [{ provide: APP_GUARD, useClass: ThrottlerGuard }],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
  }, 60_000);

  afterAll(async () => {
    await app.close();
  });

  it('accepts a retry burst well past the auth and payments limits', async () => {
    for (let i = 0; i < 25; i++) {
      await request(app.getHttpServer()).post('/hook').expect(201);
    }
  });
});
