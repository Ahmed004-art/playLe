import 'package:flutter/material.dart';

/// Collects a dispute reason (>=10 characters — the server enforces this
/// too; see `POST /matches/:id/dispute` in docs/api/README.md). Extracted
/// from Tic-Tac-Toe's private `_DisputeReasonDialog` (Phase 7) so every
/// game's financial result banner can file a dispute the same way.
class DisputeReasonDialog extends StatefulWidget {
  const DisputeReasonDialog({super.key});

  @override
  State<DisputeReasonDialog> createState() => _DisputeReasonDialogState();
}

class _DisputeReasonDialogState extends State<DisputeReasonDialog> {
  final _controller = TextEditingController();

  bool get _isValid => _controller.text.trim().length >= 10;

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return AlertDialog(
      title: const Text('File a dispute'),
      content: TextField(
        controller: _controller,
        autofocus: true,
        maxLines: 3,
        decoration: const InputDecoration(
          labelText: 'What went wrong?',
          helperText: 'At least 10 characters.',
        ),
        onChanged: (_) => setState(() {}),
      ),
      actions: [
        TextButton(
          onPressed: () => Navigator.of(context).pop(),
          child: const Text('Cancel'),
        ),
        FilledButton(
          onPressed: _isValid
              ? () => Navigator.of(context).pop(_controller.text.trim())
              : null,
          child: const Text('Submit'),
        ),
      ],
    );
  }
}
