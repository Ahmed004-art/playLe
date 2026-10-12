import { Injectable } from '@nestjs/common';
import type { AdminAuditAction } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service.js';

export interface AdminAuditMeta {
  adminId?: string;
  detail?: string;
  ipAddress?: string;
  userAgent?: string;
}

/**
 * Append-only audit trail for admin-session and account-security events
 * (login/logout/refresh, CSRF rejections, MFA changes, password resets)
 * — see `AdminAuditLog` in schema.prisma. Fire-and-forget by design: a
 * logging failure must never block or fail the security action it is
 * recording.
 */
@Injectable()
export class AdminAuditService {
  constructor(private readonly prisma: PrismaService) {}

  async record(
    action: AdminAuditAction,
    meta: AdminAuditMeta = {},
  ): Promise<void> {
    await this.prisma.adminAuditLog.create({
      data: {
        action,
        adminId: meta.adminId,
        detail: meta.detail,
        ipAddress: meta.ipAddress,
        userAgent: meta.userAgent,
      },
    });
  }
}
