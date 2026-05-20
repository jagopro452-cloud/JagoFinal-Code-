import 'dart:async';
import 'dart:convert';
import 'package:flutter/material.dart';
import 'package:google_fonts/google_fonts.dart';
import 'package:geolocator/geolocator.dart';
import 'package:http/http.dart' as http;
import '../../config/api_config.dart';
import '../../services/auth_service.dart';

class OutstationPoolTripScreen extends StatefulWidget {
  final Map<String, dynamic> ride;
  const OutstationPoolTripScreen({super.key, required this.ride});
  @override
  State<OutstationPoolTripScreen> createState() => _OutstationPoolTripScreenState();
}

class _OutstationPoolTripScreenState extends State<OutstationPoolTripScreen> {
  List<dynamic> _passengers = [];
  bool _loading = true;
  bool _actionLoading = false;
  Timer? _refreshTimer;
  Timer? _locationTimer;

  static const _primary  = Color(0xFF2D8CFF);
  static const _bg       = Color(0xFFFFFFFF);
  static const _surface  = Color(0xFFF8FAFE);
  static const _border   = Color(0xFFE5E9F0);
  static const _green    = Color(0xFF16A34A);
  static const _amber    = Color(0xFFF59E0B);
  static const _red      = Color(0xFFDC2626);
  static const _textPri  = Color(0xFF111827);
  static const _textSec  = Color(0xFF6B7280);

  Map<String, dynamic> get _ride => widget.ride;
  String get _rideId => _ride['id']?.toString() ?? '';
  bool get _isScheduled => (_ride['status'] ?? '') == 'scheduled';
  bool get _isActive    => (_ride['status'] ?? '') == 'active';

  @override
  void initState() {
    super.initState();
    _loadPassengers();
    // Poll for new bookings every 30s (active trips need more frequent updates)
    _refreshTimer = Timer.periodic(
      Duration(seconds: _isActive ? 20 : 30),
      (_) => _loadPassengers(),
    );
    if (_isActive) _startLocationUpdates();
  }

  @override
  void dispose() {
    _refreshTimer?.cancel();
    _locationTimer?.cancel();
    super.dispose();
  }

  Future<void> _loadPassengers() async {
    setState(() => _loading = true);
    try {
      final token = await AuthService.getToken();
      final res = await http.get(
        Uri.parse('${ApiConfig.baseUrl}/api/app/driver/outstation-pool/rides/$_rideId/passengers'),
        headers: {'Authorization': 'Bearer $token'},
      ).timeout(const Duration(seconds: 10));
      if (res.statusCode == 200) {
        final data = jsonDecode(res.body);
        setState(() {
          _passengers = List<dynamic>.from(data['passengers'] ?? data ?? []);
          _loading = false;
        });
      } else {
        setState(() => _loading = false);
      }
    } catch (_) {
      setState(() => _loading = false);
    }
  }

  void _startLocationUpdates() {
    _locationTimer = Timer.periodic(const Duration(seconds: 8), (_) async {
      try {
        final pos = await Geolocator.getCurrentPosition(
          locationSettings: const LocationSettings(accuracy: LocationAccuracy.high),
        ).timeout(const Duration(seconds: 5));
        final token = await AuthService.getToken();
        await http.patch(
          Uri.parse('${ApiConfig.baseUrl}/api/app/driver/outstation-pool/rides/$_rideId/location'),
          headers: {'Authorization': 'Bearer $token', 'Content-Type': 'application/json'},
          body: jsonEncode({'lat': pos.latitude, 'lng': pos.longitude}),
        ).timeout(const Duration(seconds: 5));
      } catch (_) { /* silent */ }
    });
  }

  Future<void> _startTrip() async {
    setState(() => _actionLoading = true);
    try {
      final pos = await Geolocator.getCurrentPosition(
        locationSettings: const LocationSettings(accuracy: LocationAccuracy.high),
      ).timeout(const Duration(seconds: 5));
      final token = await AuthService.getToken();
      final res = await http.post(
        Uri.parse('${ApiConfig.baseUrl}/api/app/driver/outstation-pool/rides/$_rideId/start'),
        headers: {'Authorization': 'Bearer $token', 'Content-Type': 'application/json'},
        body: jsonEncode({'lat': pos.latitude, 'lng': pos.longitude}),
      ).timeout(const Duration(seconds: 10));
      if (res.statusCode == 200) {
        _ride['status'] = 'active';
        _startLocationUpdates();
        setState(() {});
        _showSnack('Trip started! Location sharing is active.', isSuccess: true);
      } else {
        final msg = jsonDecode(res.body)['message'] ?? 'Failed to start';
        _showSnack(msg, isSuccess: false);
      }
    } catch (e) {
      _showSnack('Error: $e', isSuccess: false);
    } finally {
      setState(() => _actionLoading = false);
    }
  }

  Future<void> _pickupPassenger(String bookingId, String name) async {
    final confirm = await _confirmDialog(
      'Confirm Pickup',
      'Pick up $name?',
      confirmLabel: 'Picked Up',
    );
    if (!confirm) return;

    setState(() => _actionLoading = true);
    try {
      final token = await AuthService.getToken();
      final res = await http.post(
        Uri.parse('${ApiConfig.baseUrl}/api/app/driver/outstation-pool/passengers/$bookingId/pickup'),
        headers: {'Authorization': 'Bearer $token'},
      ).timeout(const Duration(seconds: 10));
      if (res.statusCode == 200) {
        _showSnack('$name picked up!', isSuccess: true);
        _loadPassengers();
      } else {
        _showSnack(jsonDecode(res.body)['message'] ?? 'Failed', isSuccess: false);
      }
    } catch (e) {
      _showSnack('Error: $e', isSuccess: false);
    } finally {
      setState(() => _actionLoading = false);
    }
  }

  Future<void> _dropPassenger(Map<String, dynamic> booking) async {
    final name     = booking['passenger_name'] ?? 'Passenger';
    final fare     = (booking['total_fare'] ?? 0.0) as num;
    final seats    = booking['seats_booked'] ?? 1;
    final segKm    = (booking['segment_km'] ?? 0.0) as num;
    final farePerSeat = (booking['fare_per_seat'] ?? 0.0) as num;

    // Show fare breakdown before confirming
    final confirm = await showModalBottomSheet<bool>(
      context: context,
      backgroundColor: Colors.transparent,
      isScrollControlled: true,
      builder: (_) => _DropConfirmSheet(
        passengerName: name,
        seats: seats,
        farePerSeat: farePerSeat.toDouble(),
        totalFare: fare.toDouble(),
        segmentKm: segKm.toDouble(),
        dropAddress: booking['dropoff_address'] ?? booking['drop_address'] ?? booking['to_city'] ?? '',
      ),
    );
    if (confirm != true) return;

    setState(() => _actionLoading = true);
    try {
      final token = await AuthService.getToken();
      final res = await http.post(
        Uri.parse('${ApiConfig.baseUrl}/api/app/driver/outstation-pool/passengers/${booking['id']}/drop'),
        headers: {'Authorization': 'Bearer $token'},
      ).timeout(const Duration(seconds: 10));
      if (res.statusCode == 200) {
        final data = jsonDecode(res.body);
        final earnings = (data['driverEarnings'] ?? fare).toString();
        _showSnack('$name dropped. Earnings: ₹$earnings', isSuccess: true);
        _loadPassengers();
      } else {
        _showSnack(jsonDecode(res.body)['message'] ?? 'Failed', isSuccess: false);
      }
    } catch (e) {
      _showSnack('Error: $e', isSuccess: false);
    } finally {
      setState(() => _actionLoading = false);
    }
  }

  void _showSnack(String msg, {required bool isSuccess}) {
    if (!mounted) return;
    ScaffoldMessenger.of(context).showSnackBar(SnackBar(
      content: Text(msg,
        style: GoogleFonts.poppins(fontSize: 13, color: Colors.white, fontWeight: FontWeight.w500)),
      backgroundColor: isSuccess ? _green : _red,
      behavior: SnackBarBehavior.floating,
      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12)),
      margin: const EdgeInsets.all(16),
    ));
  }

  Future<bool> _confirmDialog(String title, String body,
      {String confirmLabel = 'Confirm'}) async {
    return await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(18)),
        title: Text(title,
          style: GoogleFonts.poppins(fontWeight: FontWeight.w700, fontSize: 16, color: _textPri)),
        content: Text(body,
          style: GoogleFonts.poppins(fontSize: 14, color: _textSec)),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(ctx, false),
            child: Text('Cancel', style: GoogleFonts.poppins(color: _textSec)),
          ),
          FilledButton(
            style: FilledButton.styleFrom(backgroundColor: _primary,
              shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(10))),
            onPressed: () => Navigator.pop(ctx, true),
            child: Text(confirmLabel,
              style: GoogleFonts.poppins(fontWeight: FontWeight.w600)),
          ),
        ],
      ),
    ) ?? false;
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: _bg,
      appBar: AppBar(
        backgroundColor: _bg,
        elevation: 0,
        surfaceTintColor: Colors.transparent,
        leading: IconButton(
          icon: const Icon(Icons.arrow_back_ios_new_rounded, size: 20, color: _textPri),
          onPressed: () => Navigator.pop(context),
        ),
        title: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text('${_ride['from_city'] ?? ''} → ${_ride['to_city'] ?? ''}',
              style: GoogleFonts.poppins(fontSize: 15, fontWeight: FontWeight.w700, color: _textPri)),
            Text(_isActive ? 'Trip in progress' : _isScheduled ? 'Scheduled' : (_ride['status'] ?? '').toString(),
              style: GoogleFonts.poppins(fontSize: 11, color: _isActive ? _green : _textSec)),
          ],
        ),
        actions: [
          IconButton(
            icon: const Icon(Icons.refresh_rounded, color: _primary, size: 22),
            onPressed: _loadPassengers,
          ),
          const SizedBox(width: 4),
        ],
      ),
      body: Column(
        children: [
          _buildRideInfo(),
          if (_isScheduled)
            Padding(
              padding: const EdgeInsets.fromLTRB(16, 0, 16, 12),
              child: _PrimaryButton(
                label: _actionLoading ? 'Starting...' : 'Start Trip',
                icon: Icons.play_arrow_rounded,
                onTap: _actionLoading ? null : _startTrip,
                loading: _actionLoading,
              ),
            ),
          Expanded(
            child: _loading
                ? const Center(child: CircularProgressIndicator(color: _primary, strokeWidth: 2.5))
                : _passengers.isEmpty
                    ? _buildEmpty()
                    : RefreshIndicator(
                        color: _primary,
                        onRefresh: _loadPassengers,
                        child: ListView.builder(
                          padding: const EdgeInsets.fromLTRB(16, 4, 16, 32),
                          itemCount: _passengers.length,
                          itemBuilder: (ctx, i) => _PassengerCard(
                            booking: _passengers[i],
                            rideActive: _isActive,
                            actionLoading: _actionLoading,
                            onPickup: () => _pickupPassenger(
                              _passengers[i]['id']?.toString() ?? '',
                              _passengers[i]['passenger_name'] ?? 'Passenger',
                            ),
                            onDrop: () => _dropPassenger(_passengers[i]),
                          ),
                        ),
                      ),
          ),
        ],
      ),
    );
  }

  Widget _buildRideInfo() {
    final routeKm   = (_ride['route_km'] ?? 0.0) as num;
    final pkmps     = (_ride['price_per_km_per_seat'] ?? 1.8) as num;
    final avail     = _ride['available_seats'] ?? 0;
    final total     = _ride['total_seats'] ?? 4;
    return Container(
      margin: const EdgeInsets.fromLTRB(16, 0, 16, 12),
      padding: const EdgeInsets.all(14),
      decoration: BoxDecoration(
        color: _surface,
        borderRadius: BorderRadius.circular(14),
        border: Border.all(color: _border),
      ),
      child: Row(
        children: [
          _InfoPill(label: '${routeKm.toStringAsFixed(0)} km', icon: Icons.map_rounded, color: _primary),
          const SizedBox(width: 10),
          _InfoPill(label: '₹${pkmps.toStringAsFixed(1)}/km/seat', icon: Icons.currency_rupee_rounded, color: _green),
          const SizedBox(width: 10),
          _InfoPill(label: '${total - avail}/$total booked', icon: Icons.event_seat_rounded, color: _amber),
          if (_isActive) ...[
            const Spacer(),
            Row(children: [
              Container(width: 8, height: 8,
                decoration: const BoxDecoration(color: _green, shape: BoxShape.circle)),
              const SizedBox(width: 4),
              Text('Live', style: GoogleFonts.poppins(fontSize: 11, color: _green, fontWeight: FontWeight.w600)),
            ]),
          ],
        ],
      ),
    );
  }

  Widget _buildEmpty() {
    return Center(
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          const Icon(Icons.people_outline_rounded, size: 52, color: Color(0xFFE5E9F0)),
          const SizedBox(height: 12),
          Text('No passengers yet.\nBookings will appear here.',
            textAlign: TextAlign.center,
            style: GoogleFonts.poppins(color: _textSec, fontSize: 14)),
        ],
      ),
    );
  }
}

// ── Passenger card ────────────────────────────────────────────────────────────

class _PassengerCard extends StatelessWidget {
  final Map<String, dynamic> booking;
  final bool rideActive;
  final bool actionLoading;
  final VoidCallback onPickup;
  final VoidCallback onDrop;
  const _PassengerCard({
    required this.booking,
    required this.rideActive,
    required this.actionLoading,
    required this.onPickup,
    required this.onDrop,
  });

  static const _primary  = Color(0xFF2D8CFF);
  static const _card     = Color(0xFFFFFFFF);
  static const _amber    = Color(0xFFF59E0B);
  static const _green    = Color(0xFF16A34A);
  static const _red      = Color(0xFFDC2626);
  static const _textPri  = Color(0xFF111827);
  static const _textSec  = Color(0xFF6B7280);

  String get _status => booking['status'] ?? '';
  Color get _statusColor {
    switch (_status) {
      case 'confirmed':  return _primary;
      case 'picked_up':  return _green;
      case 'dropped':    return _green;
      case 'cancelled':  return _red;
      default:           return _amber;
    }
  }
  String get _statusLabel {
    switch (_status) {
      case 'confirmed': return 'Waiting';
      case 'picked_up': return 'On board';
      case 'dropped':   return 'Dropped';
      case 'cancelled': return 'Cancelled';
      default:          return _status.toUpperCase();
    }
  }

  @override
  Widget build(BuildContext context) {
    final name      = booking['passenger_name'] ?? 'Passenger';
    final seats     = booking['seats_booked'] ?? 1;
    final farePerSeat = (booking['fare_per_seat'] ?? 0.0) as num;
    final totalFare = (booking['total_fare'] ?? 0.0) as num;
    final segKm     = (booking['segment_km'] ?? 0.0) as num;
    final pickup    = booking['pickup_address'] ?? '';
    final drop      = booking['dropoff_address'] ?? booking['drop_address'] ?? booking['to_city'] ?? '';
    final pMethod   = booking['payment_method'] ?? 'cash';

    return Container(
      margin: const EdgeInsets.only(bottom: 12),
      decoration: BoxDecoration(
        color: _card,
        borderRadius: BorderRadius.circular(16),
        border: Border.all(color: _statusColor.withValues(alpha: 0.18)),
        boxShadow: [BoxShadow(color: Colors.black.withValues(alpha: 0.04), blurRadius: 8, offset: const Offset(0, 2))],
      ),
      child: Padding(
        padding: const EdgeInsets.all(14),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            // Name + status
            Row(
              children: [
                CircleAvatar(
                  radius: 20,
                  backgroundColor: _primary.withValues(alpha: 0.12),
                  child: Text(name.isNotEmpty ? name[0].toUpperCase() : 'P',
                    style: GoogleFonts.poppins(color: _primary, fontWeight: FontWeight.w700, fontSize: 16)),
                ),
                const SizedBox(width: 10),
                Expanded(
                  child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                    Text(name,
                      style: GoogleFonts.poppins(fontSize: 14, fontWeight: FontWeight.w600, color: _textPri)),
                    Text('$seats seat${seats > 1 ? 's' : ''}  ·  ${segKm.toStringAsFixed(0)} km',
                      style: GoogleFonts.poppins(fontSize: 12, color: _textSec)),
                  ]),
                ),
                Container(
                  padding: const EdgeInsets.symmetric(horizontal: 9, vertical: 4),
                  decoration: BoxDecoration(
                    color: _statusColor.withValues(alpha: 0.10),
                    borderRadius: BorderRadius.circular(8),
                    border: Border.all(color: _statusColor.withValues(alpha: 0.25)),
                  ),
                  child: Text(_statusLabel,
                    style: GoogleFonts.poppins(
                      color: _statusColor, fontSize: 11, fontWeight: FontWeight.w600)),
                ),
              ],
            ),

            // Fare breakdown
            const SizedBox(height: 12),
            Container(
              padding: const EdgeInsets.all(10),
              decoration: BoxDecoration(
                color: const Color(0xFFF3F7FF),
                borderRadius: BorderRadius.circular(10),
              ),
              child: Column(children: [
                _FareRow('Fare/seat', '₹${farePerSeat.toStringAsFixed(0)}'),
                if (seats > 1)
                  _FareRow('× $seats seats', '= ₹${totalFare.toStringAsFixed(0)}',
                    isBold: true, color: _primary),
                if (seats == 1)
                  _FareRow('Total', '₹${totalFare.toStringAsFixed(0)}',
                    isBold: true, color: _primary),
                _FareRow('Payment', pMethod.toUpperCase(), color: _textSec),
              ]),
            ),

            // Pickup / drop addresses
            if (pickup.isNotEmpty || drop.isNotEmpty) ...[
              const SizedBox(height: 10),
              if (pickup.isNotEmpty) _AddressRow(Icons.circle_rounded, pickup, const Color(0xFF16A34A)),
              if (drop.isNotEmpty)   _AddressRow(Icons.location_on_rounded, drop, const Color(0xFFDC2626)),
            ],

            // Action buttons
            if (rideActive && (_status == 'confirmed' || _status == 'picked_up')) ...[
              const SizedBox(height: 12),
              Row(children: [
                if (_status == 'confirmed')
                  Expanded(
                    child: _ActionButton(
                      label: 'Picked Up',
                      icon: Icons.person_add_rounded,
                      color: _green,
                      loading: actionLoading,
                      onTap: onPickup,
                    ),
                  ),
                if (_status == 'picked_up') ...[
                  Expanded(
                    child: _ActionButton(
                      label: 'Drop  ₹${totalFare.toStringAsFixed(0)}',
                      icon: Icons.person_remove_rounded,
                      color: _primary,
                      loading: actionLoading,
                      onTap: onDrop,
                    ),
                  ),
                ],
              ]),
            ],
          ],
        ),
      ),
    );
  }
}

// ── Drop confirm bottom sheet ─────────────────────────────────────────────────

class _DropConfirmSheet extends StatelessWidget {
  final String passengerName;
  final int seats;
  final double farePerSeat;
  final double totalFare;
  final double segmentKm;
  final String dropAddress;

  const _DropConfirmSheet({
    required this.passengerName,
    required this.seats,
    required this.farePerSeat,
    required this.totalFare,
    required this.segmentKm,
    required this.dropAddress,
  });

  static const _primary  = Color(0xFF2D8CFF);
  static const _green    = Color(0xFF16A34A);
  static const _textPri  = Color(0xFF111827);
  static const _textSec  = Color(0xFF6B7280);
  static const _border   = Color(0xFFE5E9F0);

  @override
  Widget build(BuildContext context) {
    return Container(
      decoration: const BoxDecoration(
        color: Colors.white,
        borderRadius: BorderRadius.vertical(top: Radius.circular(24)),
      ),
      padding: const EdgeInsets.fromLTRB(20, 16, 20, 32),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Center(
            child: Container(width: 36, height: 4,
              decoration: BoxDecoration(
                color: const Color(0xFFE5E9F0),
                borderRadius: BorderRadius.circular(2))),
          ),
          const SizedBox(height: 18),
          Text('Drop $passengerName',
            style: GoogleFonts.poppins(fontSize: 18, fontWeight: FontWeight.w700, color: _textPri)),
          const SizedBox(height: 4),
          Text(dropAddress.isNotEmpty ? dropAddress : 'Destination',
            style: GoogleFonts.poppins(fontSize: 13, color: _textSec)),
          const SizedBox(height: 16),
          Container(
            padding: const EdgeInsets.all(14),
            decoration: BoxDecoration(
              color: const Color(0xFFF3F7FF),
              borderRadius: BorderRadius.circular(14),
              border: Border.all(color: _border),
            ),
            child: Column(children: [
              _FareRow('Segment distance', '${segmentKm.toStringAsFixed(1)} km'),
              _FareRow('Fare per seat', '₹${farePerSeat.toStringAsFixed(0)}'),
              if (seats > 1)
                _FareRow('× $seats seats', '', isBold: false),
              Divider(color: _border, height: 20),
              _FareRow('Total fare', '₹${totalFare.toStringAsFixed(0)}',
                isBold: true, color: _primary),
            ]),
          ),
          const SizedBox(height: 8),
          Text('Commission (15%) + GST + insurance will be deducted from your earnings.',
            style: GoogleFonts.poppins(fontSize: 11, color: _textSec)),
          const SizedBox(height: 20),
          Row(children: [
            Expanded(
              child: GestureDetector(
                onTap: () => Navigator.pop(context, false),
                child: Container(
                  height: 50,
                  decoration: BoxDecoration(
                    border: Border.all(color: _border),
                    borderRadius: BorderRadius.circular(14),
                  ),
                  child: Center(
                    child: Text('Cancel',
                      style: GoogleFonts.poppins(fontWeight: FontWeight.w600, color: _textSec))),
                ),
              ),
            ),
            const SizedBox(width: 12),
            Expanded(
              child: GestureDetector(
                onTap: () => Navigator.pop(context, true),
                child: Container(
                  height: 50,
                  decoration: BoxDecoration(
                    color: _green,
                    borderRadius: BorderRadius.circular(14),
                    boxShadow: [BoxShadow(
                      color: _green.withValues(alpha: 0.25), blurRadius: 10, offset: const Offset(0, 4))],
                  ),
                  child: Center(
                    child: Text('Confirm Drop  ₹${totalFare.toStringAsFixed(0)}',
                      style: GoogleFonts.poppins(
                        color: Colors.white, fontWeight: FontWeight.w700, fontSize: 14))),
                ),
              ),
            ),
          ]),
        ],
      ),
    );
  }
}

// ── Small shared widgets ──────────────────────────────────────────────────────

class _FareRow extends StatelessWidget {
  final String label;
  final String value;
  final bool isBold;
  final Color? color;
  const _FareRow(this.label, this.value, {this.isBold = false, this.color});

  @override
  Widget build(BuildContext context) {
    final c = color ?? const Color(0xFF111827);
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 2),
      child: Row(
        mainAxisAlignment: MainAxisAlignment.spaceBetween,
        children: [
          Text(label,
            style: GoogleFonts.poppins(fontSize: 12, color: const Color(0xFF6B7280))),
          Text(value,
            style: GoogleFonts.poppins(
              fontSize: 12,
              fontWeight: isBold ? FontWeight.w700 : FontWeight.w500,
              color: c,
            )),
        ],
      ),
    );
  }
}

class _AddressRow extends StatelessWidget {
  final IconData icon;
  final String address;
  final Color iconColor;
  const _AddressRow(this.icon, this.address, this.iconColor);

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.only(bottom: 4),
      child: Row(
        children: [
          Icon(icon, size: 12, color: iconColor),
          const SizedBox(width: 6),
          Expanded(
            child: Text(address, maxLines: 1, overflow: TextOverflow.ellipsis,
              style: GoogleFonts.poppins(fontSize: 12, color: const Color(0xFF6B7280))),
          ),
        ],
      ),
    );
  }
}

class _InfoPill extends StatelessWidget {
  final String label;
  final IconData icon;
  final Color color;
  const _InfoPill({required this.label, required this.icon, required this.color});

  @override
  Widget build(BuildContext context) {
    return Row(mainAxisSize: MainAxisSize.min, children: [
      Icon(icon, size: 13, color: color),
      const SizedBox(width: 4),
      Text(label, style: GoogleFonts.poppins(fontSize: 11, color: color, fontWeight: FontWeight.w600)),
    ]);
  }
}

class _PrimaryButton extends StatelessWidget {
  final String label;
  final IconData icon;
  final VoidCallback? onTap;
  final bool loading;
  const _PrimaryButton({
    required this.label, required this.icon,
    required this.onTap, this.loading = false,
  });

  @override
  Widget build(BuildContext context) {
    return GestureDetector(
      onTap: onTap,
      child: Container(
        height: 52,
        decoration: BoxDecoration(
          color: const Color(0xFF2D8CFF),
          borderRadius: BorderRadius.circular(14),
          boxShadow: [BoxShadow(
            color: const Color(0xFF2D8CFF).withValues(alpha: 0.25),
            blurRadius: 12, offset: const Offset(0, 4))],
        ),
        child: Center(
          child: loading
              ? const SizedBox(width: 22, height: 22,
                  child: CircularProgressIndicator(color: Colors.white, strokeWidth: 2.5))
              : Row(mainAxisSize: MainAxisSize.min, children: [
                  Icon(icon, color: Colors.white, size: 20),
                  const SizedBox(width: 8),
                  Text(label,
                    style: GoogleFonts.poppins(
                      color: Colors.white, fontWeight: FontWeight.w700, fontSize: 15)),
                ]),
        ),
      ),
    );
  }
}

class _ActionButton extends StatelessWidget {
  final String label;
  final IconData icon;
  final Color color;
  final bool loading;
  final VoidCallback? onTap;
  const _ActionButton({
    required this.label, required this.icon,
    required this.color, required this.loading, required this.onTap,
  });

  @override
  Widget build(BuildContext context) {
    return GestureDetector(
      onTap: loading ? null : onTap,
      child: Container(
        height: 44,
        decoration: BoxDecoration(
          color: color,
          borderRadius: BorderRadius.circular(12),
          boxShadow: [BoxShadow(
            color: color.withValues(alpha: 0.22), blurRadius: 8, offset: const Offset(0, 3))],
        ),
        child: Center(
          child: loading
              ? const SizedBox(width: 18, height: 18,
                  child: CircularProgressIndicator(color: Colors.white, strokeWidth: 2.5))
              : Row(mainAxisSize: MainAxisSize.min, children: [
                  Icon(icon, color: Colors.white, size: 17),
                  const SizedBox(width: 6),
                  Text(label,
                    style: GoogleFonts.poppins(
                      color: Colors.white, fontWeight: FontWeight.w700, fontSize: 13)),
                ]),
        ),
      ),
    );
  }
}
