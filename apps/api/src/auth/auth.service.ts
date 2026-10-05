import {
  ConflictException,
  Injectable,
  UnauthorizedException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma, type User } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service.js';
import { UsersService } from '../users/users.service.js';
import { PasswordService } from './password.service.js';
import { TokenService, type IssuedTokenPair } from './token.service.js';
import { calculateAge } from './utils/age.util.js';
import { normalizeEmail, normalizePhoneNumber } from './utils/phone.util.js';
import type { RegisterDto } from './dto/register.dto.js';
import type { LoginDto } from './dto/login.dto.js';
import type { ChangePasswordDto } from './dto/change-password.dto.js';
import type { AppConfiguration } from '../config/configuration.js';

interface RequestMeta {
  userAgent?: string;
  ipAddress?: string;
}

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly usersService: UsersService,
    private readonly passwordService: PasswordService,
    private readonly tokenService: TokenService,
    private readonly configService: ConfigService<AppConfiguration, true>,
  ) {}

  async register(
    dto: RegisterDto,
    meta: RequestMeta = {},
  ): Promise<{ user: User } & IssuedTokenPair> {
    const email = normalizeEmail(dto.email);

    let phoneNumber: string | undefined;
    if (dto.phoneNumber) {
      const normalized = normalizePhoneNumber(dto.phoneNumber);
      if (!normalized) {
        throw new UnprocessableEntityException(
          'phoneNumber is not a valid phone number',
        );
      }
      phoneNumber = normalized;
    }

    const dateOfBirth = new Date(dto.dateOfBirth);
    const minAge = this.configService.get('auth.minAgeYears', { infer: true });

    if (calculateAge(dateOfBirth) < minAge) {
      throw new UnprocessableEntityException(
        `You must be at least ${minAge} years old to create a PlayLe account`,
      );
    }

    const passwordHash = await this.passwordService.hash(dto.password);

    let user: User;
    try {
      user = await this.prisma.$transaction(async (tx) => {
        const created = await tx.user.create({
          data: {
            email,
            phoneNumber,
            username: dto.username,
            passwordHash,
            dateOfBirth,
            lastLoginAt: new Date(),
          },
        });
        // Every user gets exactly one wallet from the moment they
        // register — see docs/decisions/ADR-012-financial-architecture.md.
        // No code elsewhere needs to handle a "wallet doesn't exist yet".
        await tx.wallet.create({ data: { userId: created.id } });
        return created;
      });
    } catch (error) {
      throw this.mapUniqueConstraintError(error);
    }

    const tokens = await this.tokenService.issueTokenPair(user, meta);
    return { user, ...tokens };
  }

  async login(
    dto: LoginDto,
    meta: RequestMeta = {},
  ): Promise<{ user: User } & IssuedTokenPair> {
    const identifier = dto.identifier.includes('@')
      ? normalizeEmail(dto.identifier)
      : (normalizePhoneNumber(dto.identifier) ?? dto.identifier);

    const user = await this.usersService.findByIdentifier(identifier);

    // Always run a hash comparison even when no user is found, so response
    // timing doesn't reveal whether the identifier exists (a lightweight
    // mitigation for user-enumeration via timing).
    const passwordValid = await this.passwordService.verify(
      user?.passwordHash ?? this.dummyHash,
      dto.password,
    );

    if (!user || !passwordValid) {
      throw new UnauthorizedException('Invalid credentials');
    }

    if (user.status !== 'ACTIVE') {
      throw new UnauthorizedException(
        `Account is ${user.status.toLowerCase()}`,
      );
    }

    await this.usersService.updateLastLogin(user.id);
    const tokens = await this.tokenService.issueTokenPair(user, meta);

    return { user: { ...user, lastLoginAt: new Date() }, ...tokens };
  }

  async refresh(
    rawRefreshToken: string,
    meta: RequestMeta = {},
  ): Promise<{ user: User } & IssuedTokenPair> {
    const result = await this.tokenService.rotateRefreshToken(
      rawRefreshToken,
      meta,
    );

    if (result.user.status !== 'ACTIVE') {
      await this.tokenService.revokeAllForUser(result.user.id);
      throw new UnauthorizedException(
        `Account is ${result.user.status.toLowerCase()}`,
      );
    }

    return result;
  }

  async logout(rawRefreshToken: string, userId: string): Promise<void> {
    await this.tokenService.revokeRefreshToken(rawRefreshToken, userId);
  }

  async changePassword(user: User, dto: ChangePasswordDto): Promise<void> {
    const valid = await this.passwordService.verify(
      user.passwordHash,
      dto.currentPassword,
    );

    if (!valid) {
      throw new UnauthorizedException('Current password is incorrect');
    }

    const newPasswordHash = await this.passwordService.hash(dto.newPassword);

    await this.prisma.user.update({
      where: { id: user.id },
      data: { passwordHash: newPasswordHash },
    });

    // Changing a password invalidates every existing session — including
    // this one's refresh token — forcing re-authentication everywhere.
    await this.tokenService.revokeAllForUser(user.id);
  }

  /** A real (but never-matching) argon2id hash used to keep login timing uniform when no user is found. */
  private readonly dummyHash =
    '$argon2id$v=19$m=65536,p=4,t=3$unlTPyuiEAabZGIddXt3XQ$SvJ9UvfqUbX/emJ7R2IKG01jGpA4sHA6d4AvMSuSaUk';

  private mapUniqueConstraintError(error: unknown): Error {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === 'P2002'
    ) {
      const target =
        (error.meta?.target as string[] | undefined)?.join(', ') ?? 'field';
      return new ConflictException(
        `An account with this ${target} already exists`,
      );
    }
    return error as Error;
  }
}
