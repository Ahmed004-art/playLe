import 'package:flutter/material.dart';

import '../../core/theme/app_colors.dart';

/// Maps a `DepositStatus` (see `apps/api/prisma/schema.prisma`) to a short
/// label/color/explanation for display. Centralized here so both
/// `DepositScreen` and anywhere else a deposit is shown use the same
/// mapping — in particular `EXPIRED` (Phase 6 — a Payment Code that
/// wasn't dialed in time; no ledger effect, never credited).
class DepositStatusPresentation {
  const DepositStatusPresentation(this.label, this.color, this.description);

  final String label;
  final Color color;
  final String description;
}

DepositStatusPresentation depositStatusPresentation(String status) {
  switch (status) {
    case 'PENDING':
      return const DepositStatusPresentation(
        'Pending',
        AppColors.onSurfaceMuted,
        'Waiting for you to complete the payment on your phone.',
      );
    case 'COMPLETED':
      return const DepositStatusPresentation(
        'Completed',
        AppColors.secondary,
        'Confirmed — your balance has been updated.',
      );
    case 'FAILED':
      return const DepositStatusPresentation(
        'Failed',
        AppColors.error,
        'This deposit could not be completed.',
      );
    case 'CANCELLED':
      return const DepositStatusPresentation(
        'Cancelled',
        AppColors.onSurfaceMuted,
        'This deposit was cancelled.',
      );
    case 'EXPIRED':
      return const DepositStatusPresentation(
        'Expired',
        AppColors.error,
        'The payment code expired before it was used. Start a new '
            'deposit to try again.',
      );
    default:
      return DepositStatusPresentation(status, AppColors.onSurfaceMuted, '');
  }
}

/// Maps a `WithdrawalStatus` to a short label/color/explanation.
/// `PROCESSING` (Phase 6) is distinguished from `PENDING_REVIEW`/
/// `APPROVED` — see docs/decisions/ADR-019-production-payments.md.
class WithdrawalStatusPresentation {
  const WithdrawalStatusPresentation(this.label, this.color, this.description);

  final String label;
  final Color color;
  final String description;
}

WithdrawalStatusPresentation withdrawalStatusPresentation(String status) {
  switch (status) {
    case 'PENDING_REVIEW':
      return const WithdrawalStatusPresentation(
        'Awaiting review',
        AppColors.onSurfaceMuted,
        'Your funds are held. PlayLe has not reviewed this request yet.',
      );
    case 'APPROVED':
      return const WithdrawalStatusPresentation(
        'Approved',
        AppColors.secondary,
        'Approved — payout is about to be submitted.',
      );
    case 'PROCESSING':
      return const WithdrawalStatusPresentation(
        'Processing',
        AppColors.secondary,
        'Your payout is being processed by our payment provider. This '
            'can take a while if the provider hasn\'t confirmed the '
            'outcome yet — your funds stay held and safe in the meantime.',
      );
    case 'REJECTED':
      return const WithdrawalStatusPresentation(
        'Rejected',
        AppColors.error,
        'This withdrawal was rejected and the held funds were released.',
      );
    case 'COMPLETED':
      return const WithdrawalStatusPresentation(
        'Completed',
        AppColors.secondary,
        'Paid out successfully.',
      );
    case 'FAILED':
      return const WithdrawalStatusPresentation(
        'Failed',
        AppColors.error,
        'The payout failed and the held funds were released.',
      );
    case 'CANCELLED':
      return const WithdrawalStatusPresentation(
        'Cancelled',
        AppColors.onSurfaceMuted,
        'You cancelled this withdrawal before it was reviewed.',
      );
    default:
      return WithdrawalStatusPresentation(status, AppColors.onSurfaceMuted, '');
  }
}

/// A small colored pill showing a status label — shared by the deposit
/// and withdrawal screens.
class StatusBadge extends StatelessWidget {
  const StatusBadge({super.key, required this.label, required this.color});

  final String label;
  final Color color;

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 4),
      decoration: BoxDecoration(
        color: color.withValues(alpha: 0.15),
        borderRadius: BorderRadius.circular(20),
        border: Border.all(color: color),
      ),
      child: Text(
        label,
        style: TextStyle(
          color: color,
          fontWeight: FontWeight.w600,
          fontSize: 12,
        ),
      ),
    );
  }
}
