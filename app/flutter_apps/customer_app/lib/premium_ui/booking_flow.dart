import 'package:flutter/material.dart';
import 'theme.dart';
import 'glass_card.dart';

class BookingFlowScreen extends StatefulWidget {
  const BookingFlowScreen({super.key});

  @override
  State<BookingFlowScreen> createState() => _BookingFlowScreenState();
}

class _BookingFlowScreenState extends State<BookingFlowScreen> {
  int _step = 0;
  String? _pickup;
  String? _drop;
  String _rideType = 'Bike';

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: JagoTheme.background,
      appBar: AppBar(
        backgroundColor: Colors.transparent,
        elevation: 0,
        leading: IconButton(
          icon: const Icon(Icons.arrow_back_ios_new_rounded, color: JagoTheme.primaryBlue),
          onPressed: () {
            if (_step == 0) Navigator.pop(context);
            else setState(() => _step--);
          },
        ),
        title: Text('Book Ride', style: TextStyle(color: JagoTheme.textDark, fontWeight: FontWeight.bold)),
        centerTitle: true,
      ),
      body: AnimatedSwitcher(
        duration: const Duration(milliseconds: 350),
        child: _step == 0 ? _pickupStep() : _step == 1 ? _dropStep() : _confirmStep(),
      ),
    );
  }

  Widget _pickupStep() {
    return Center(
      child: GlassCard(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            const Text('Select Pickup', style: TextStyle(fontSize: 18, fontWeight: FontWeight.bold)),
            const SizedBox(height: 18),
            TextField(
              decoration: InputDecoration(
                hintText: 'Pickup location',
                prefixIcon: const Icon(Icons.my_location_rounded, color: JagoTheme.primaryBlue),
                border: OutlineInputBorder(borderRadius: BorderRadius.circular(16), borderSide: BorderSide.none),
                filled: true,
                fillColor: Colors.white.withValues(alpha: 0.9),
              ),
              onChanged: (v) => _pickup = v,
            ),
            const SizedBox(height: 18),
            SizedBox(
              width: double.infinity,
              child: ElevatedButton(
                style: ElevatedButton.styleFrom(
                  padding: const EdgeInsets.symmetric(vertical: 16),
                  shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(16)),
                  backgroundColor: JagoTheme.primaryBlue,
                ),
                onPressed: () => setState(() => _step = 1),
                child: const Text('Next', style: TextStyle(color: Colors.white, fontWeight: FontWeight.bold)),
              ),
            ),
          ],
        ),
      ),
    );
  }

  Widget _dropStep() {
    return Center(
      child: GlassCard(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            const Text('Select Drop', style: TextStyle(fontSize: 18, fontWeight: FontWeight.bold)),
            const SizedBox(height: 18),
            TextField(
              decoration: InputDecoration(
                hintText: 'Drop location',
                prefixIcon: const Icon(Icons.location_on_rounded, color: JagoTheme.primaryBlue),
                border: OutlineInputBorder(borderRadius: BorderRadius.circular(16), borderSide: BorderSide.none),
                filled: true,
                fillColor: Colors.white.withValues(alpha: 0.9),
              ),
              onChanged: (v) => _drop = v,
            ),
            const SizedBox(height: 18),
            SizedBox(
              width: double.infinity,
              child: ElevatedButton(
                style: ElevatedButton.styleFrom(
                  padding: const EdgeInsets.symmetric(vertical: 16),
                  shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(16)),
                  backgroundColor: JagoTheme.primaryBlue,
                ),
                onPressed: () => setState(() => _step = 2),
                child: const Text('Next', style: TextStyle(color: Colors.white, fontWeight: FontWeight.bold)),
              ),
            ),
          ],
        ),
      ),
    );
  }

  Widget _confirmStep() {
    return Center(
      child: GlassCard(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            const Text('Confirm Ride', style: TextStyle(fontSize: 18, fontWeight: FontWeight.bold)),
            const SizedBox(height: 18),
            Row(
              children: [
                const Icon(Icons.my_location_rounded, color: JagoTheme.primaryBlue),
                const SizedBox(width: 8),
                Expanded(child: Text(_pickup ?? '', style: const TextStyle(fontWeight: FontWeight.w500))),
              ],
            ),
            const SizedBox(height: 10),
            Row(
              children: [
                const Icon(Icons.location_on_rounded, color: JagoTheme.primaryBlue),
                const SizedBox(width: 8),
                Expanded(child: Text(_drop ?? '', style: const TextStyle(fontWeight: FontWeight.w500))),
              ],
            ),
            const SizedBox(height: 18),
            // Ride type selection
            Row(
              mainAxisAlignment: MainAxisAlignment.spaceEvenly,
              children: [
                _RideTypeOption(
                  icon: Icons.electric_bike_rounded,
                  label: 'Bike',
                  selected: _rideType == 'Bike',
                  onTap: () => setState(() => _rideType = 'Bike'),
                ),
                _RideTypeOption(
                  icon: Icons.electric_rickshaw_rounded,
                  label: 'Auto',
                  selected: _rideType == 'Auto',
                  onTap: () => setState(() => _rideType = 'Auto'),
                ),
                _RideTypeOption(
                  icon: Icons.local_shipping_rounded,
                  label: 'Parcel',
                  selected: _rideType == 'Parcel',
                  onTap: () => setState(() => _rideType = 'Parcel'),
                ),
              ],
            ),
            const SizedBox(height: 18),
            // Price display (dummy)
            Text('₹120', style: TextStyle(fontSize: 22, color: JagoTheme.primaryBlue, fontWeight: FontWeight.bold)),
            const SizedBox(height: 18),
            SizedBox(
              width: double.infinity,
              child: ElevatedButton(
                style: ElevatedButton.styleFrom(
                  padding: const EdgeInsets.symmetric(vertical: 16),
                  shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(16)),
                  backgroundColor: JagoTheme.primaryBlue,
                ),
                onPressed: () {
                  Navigator.pushNamed(context, '/tracking');
                },
                child: const Text('Confirm Ride', style: TextStyle(color: Colors.white, fontWeight: FontWeight.bold)),
              ),
            ),
          ],
        ),
      ),
    );
  }
}

class _RideTypeOption extends StatelessWidget {
  final IconData icon;
  final String label;
  final bool selected;
  final VoidCallback onTap;
  const _RideTypeOption({required this.icon, required this.label, required this.selected, required this.onTap});

  @override
  Widget build(BuildContext context) {
    return GestureDetector(
      onTap: onTap,
      child: AnimatedContainer(
        duration: const Duration(milliseconds: 200),
        padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 10),
        decoration: BoxDecoration(
          gradient: selected ? JagoTheme.primaryGradient : null,
          color: selected ? null : Colors.white.withValues(alpha: 0.9),
          borderRadius: BorderRadius.circular(14),
          boxShadow: [
            BoxShadow(
              color: JagoTheme.primaryBlue.withValues(alpha: 0.08),
              blurRadius: 8,
              offset: const Offset(0, 2),
            ),
          ],
        ),
        child: Row(
          children: [
            Icon(icon, color: selected ? Colors.white : JagoTheme.primaryBlue, size: 22),
            const SizedBox(width: 8),
            Text(label, style: TextStyle(color: selected ? Colors.white : JagoTheme.primaryBlue, fontWeight: FontWeight.w600)),
          ],
        ),
      ),
    );
  }
}
