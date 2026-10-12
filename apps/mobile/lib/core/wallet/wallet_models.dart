/// Money is always an integer count of minor units (1 SLE = 100 minor
/// units) and always travels over the wire as a decimal string — never a
/// `double` — matching the backend's representation (see
/// docs/decisions/ADR-012-financial-architecture.md). These model classes
/// keep that string as-is; only the UI layer formats it for display.
class Wallet {
  const Wallet({
    required this.availableBalanceMinor,
    required this.heldBalanceMinor,
    required this.totalBalanceMinor,
    required this.currency,
  });

  factory Wallet.fromJson(Map<String, dynamic> json) {
    return Wallet(
      availableBalanceMinor: json['availableBalanceMinor'] as String,
      heldBalanceMinor: json['heldBalanceMinor'] as String,
      totalBalanceMinor: json['totalBalanceMinor'] as String,
      currency: json['currency'] as String,
    );
  }

  final String availableBalanceMinor;
  final String heldBalanceMinor;
  final String totalBalanceMinor;
  final String currency;
}

class LedgerEntry {
  const LedgerEntry({
    required this.id,
    required this.type,
    required this.availableDeltaMinor,
    required this.heldDeltaMinor,
    required this.currency,
    required this.createdAt,
    this.reason,
  });

  factory LedgerEntry.fromJson(Map<String, dynamic> json) {
    return LedgerEntry(
      id: json['id'] as String,
      type: json['type'] as String,
      availableDeltaMinor: json['availableDeltaMinor'] as String,
      heldDeltaMinor: json['heldDeltaMinor'] as String,
      currency: json['currency'] as String,
      createdAt: DateTime.parse(json['createdAt'] as String),
      reason: json['reason'] as String?,
    );
  }

  final String id;
  final String type;
  final String availableDeltaMinor;
  final String heldDeltaMinor;
  final String currency;
  final DateTime createdAt;
  final String? reason;
}

/// Real-action USSD "Payment Code" instructions for a Payment-Code-backed
/// deposit (Monime — see docs/decisions/ADR-019-production-payments.md).
/// Absent for a MANUAL-provider deposit. PlayLe never dials this code or
/// confirms the deposit automatically — the user must do it themselves on
/// their own phone.
class DepositPaymentInstructions {
  const DepositPaymentInstructions({this.ussdCode, this.expiresAt});

  factory DepositPaymentInstructions.fromJson(Map<String, dynamic> json) {
    return DepositPaymentInstructions(
      ussdCode: json['ussdCode'] as String?,
      expiresAt: json['expiresAt'] == null
          ? null
          : DateTime.parse(json['expiresAt'] as String),
    );
  }

  final String? ussdCode;
  final DateTime? expiresAt;
}

class Deposit {
  const Deposit({
    required this.id,
    required this.amountMinor,
    required this.currency,
    required this.status,
    required this.provider,
    required this.createdAt,
    this.providerReference,
    this.failureReason,
    this.paymentInstructions,
  });

  factory Deposit.fromJson(Map<String, dynamic> json) {
    return Deposit(
      id: json['id'] as String,
      amountMinor: json['amountMinor'] as String,
      currency: json['currency'] as String,
      status: json['status'] as String,
      provider: json['provider'] as String,
      createdAt: DateTime.parse(json['createdAt'] as String),
      providerReference: json['providerReference'] as String?,
      failureReason: json['failureReason'] as String?,
      paymentInstructions: json['paymentInstructions'] == null
          ? null
          : DepositPaymentInstructions.fromJson(
              json['paymentInstructions'] as Map<String, dynamic>,
            ),
    );
  }

  final String id;
  final String amountMinor;
  final String currency;
  final String status;
  final String provider;
  final DateTime createdAt;
  final String? providerReference;
  final String? failureReason;
  final DepositPaymentInstructions? paymentInstructions;

  /// Terminal statuses: once reached, no further webhook-driven change is
  /// expected, so polling can stop (`PENDING` is the only non-terminal
  /// deposit status — see `apps/api/prisma/schema.prisma`'s `DepositStatus`).
  bool get isTerminal => status != 'PENDING';
}

class Withdrawal {
  const Withdrawal({
    required this.id,
    required this.amountMinor,
    required this.currency,
    required this.status,
    required this.createdAt,
    this.failureReason,
  });

  factory Withdrawal.fromJson(Map<String, dynamic> json) {
    return Withdrawal(
      id: json['id'] as String,
      amountMinor: json['amountMinor'] as String,
      currency: json['currency'] as String,
      status: json['status'] as String,
      createdAt: DateTime.parse(json['createdAt'] as String),
      failureReason: json['failureReason'] as String?,
    );
  }

  final String id;
  final String amountMinor;
  final String currency;
  final String status;
  final DateTime createdAt;
  final String? failureReason;

  /// `PENDING_REVIEW`, `APPROVED`, and `PROCESSING` are all non-terminal
  /// (see `apps/api/prisma/schema.prisma`'s `WithdrawalStatus` and
  /// docs/decisions/ADR-019-production-payments.md's `PROCESSING` note).
  bool get isTerminal =>
      status != 'PENDING_REVIEW' &&
      status != 'APPROVED' &&
      status != 'PROCESSING';
}
