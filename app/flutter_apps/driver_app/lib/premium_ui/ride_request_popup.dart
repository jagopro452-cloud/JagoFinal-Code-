import 'package:flutter/material.dart';
import 'theme.dart';
import 'glass_card.dart';

class RideRequestPopup extends StatelessWidget {
  final String pickup;
  final String drop;
  final String distance;
  final String price;
  final VoidCallback onAccept;
  final VoidCallback onReject;
  const RideRequestPopup({
    super.key,
    required this.pickup,
    required this.drop,
    required this.distance,
    required this.price,
    required this.onAccept,
    required this.onReject,
  });

  @override
  Widget build(BuildContext context) {
    return Center(
      child: GlassCard(
        padding: const EdgeInsets.symmetric(horizontal: 24, vertical: 28),
        borderRadius: 28,
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                const Icon(Icons.location_on_rounded, color: JagoTheme.primaryBlue),
                const SizedBox(width: 8),
                Expanded(child: Text(pickup, style: const TextStyle(fontWeight: FontWeight.bold, fontSize: 16))),
              ],
            ),
            const SizedBox(height: 10),
            Row(
              children: [
                const Icon(Icons.flag_rounded, color: JagoTheme.primaryBlue),
                const SizedBox(width: 8),
                Expanded(child: Text(drop, style: const TextStyle(fontWeight: FontWeight.bold, fontSize: 16))),
              ],
            ),
            const SizedBox(height: 18),
            Row(
              children: [
                Icon(Icons.route_rounded, color: JagoTheme.primaryBlue.withValues(alpha: 0.7)),
                const SizedBox(width: 6),
                Text(distance, style: const TextStyle(fontWeight: FontWeight.w500)),
                const SizedBox(width: 18),
                Icon(Icons.attach_money_rounded, color: JagoTheme.primaryBlue.withValues(alpha: 0.7)),
                const SizedBox(width: 6),
                Text(price, style: const TextStyle(fontWeight: FontWeight.w500)),
              ],
            ),
            const SizedBox(height: 24),
            Row(
              children: [
                Expanded(
                  child: OutlinedButton(
                    style: OutlinedButton.styleFrom(
                      padding: const EdgeInsets.symmetric(vertical: 16),
                      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(16)),
                      side: BorderSide(color: JagoTheme.primaryBlue.withValues(alpha: 0.7), width: 1.5),
                    ),
                    onPressed: onReject,
                    child: Text('Reject', style: TextStyle(color: JagoTheme.primaryBlue, fontWeight: FontWeight.bold)),
                  ),
                ),
                const SizedBox(width: 16),
                Expanded(
                  child: ElevatedButton(
                    style: ElevatedButton.styleFrom(
                      padding: const EdgeInsets.symmetric(vertical: 16),
                      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(16)),
                      backgroundColor: Colors.transparent,
                      shadowColor: Colors.transparent,
                    ),
                    onPressed: onAccept,
                    child: Ink(
                      decoration: BoxDecoration(
                        gradient: JagoTheme.primaryGradient,
                        borderRadius: BorderRadius.circular(16),
                      ),
                      child: Container(
                        alignment: Alignment.center,
                        child: const Text('Accept', style: TextStyle(color: Colors.white, fontWeight: FontWeight.bold)),
                      ),
                    ),
                  ),
                ),
              ],
            ),
          ],
        ),
      ),
    );
  }
}
