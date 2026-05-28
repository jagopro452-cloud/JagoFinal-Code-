import 'dart:async';
import 'dart:convert';
import 'package:flutter/material.dart';
import 'package:google_maps_flutter/google_maps_flutter.dart';
import 'package:http/http.dart' as http;
import 'package:intl/intl.dart';
import '../../config/api_config.dart';
import '../../config/jago_theme.dart';
import '../../services/auth_service.dart';
import '../../services/socket_service.dart';
import '../call/call_screen.dart';
import '../chat/trip_chat_sheet.dart';
import '../profile/support_chat_screen.dart';
import '../tracking/pool_experience_screens.dart';

class OutstationPoolScreen extends StatefulWidget {
  const OutstationPoolScreen({super.key});
  @override
  State<OutstationPoolScreen> createState() => _OutstationPoolScreenState();
}

class _OutstationPoolScreenState extends State<OutstationPoolScreen>
    with SingleTickerProviderStateMixin {
  late final TabController _tabs;

  @override
  void initState() {
    super.initState();
    _tabs = TabController(length: 2, vsync: this);
  }

  @override
  void dispose() {
    _tabs.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: JT.bgSoft,
      appBar: AppBar(
        backgroundColor: JT.primary,
        foregroundColor: Colors.white,
        title: const Text('Outstation Pool', style: TextStyle(fontWeight: FontWeight.w500)),
        elevation: 0,
        bottom: TabBar(
          controller: _tabs,
          indicatorColor: Colors.white,
          labelColor: Colors.white,
          unselectedLabelColor: Colors.white70,
          tabs: const [
            Tab(icon: Icon(Icons.search_rounded), text: 'Search Rides'),
            Tab(icon: Icon(Icons.confirmation_number_rounded), text: 'My Bookings'),
          ],
        ),
      ),
      body: TabBarView(
        controller: _tabs,
        children: const [
          _SearchTab(),
          _BookingsTab(),
        ],
      ),
    );
  }
}

// ── Search Tab ────────────────────────────────────────────────────────────────

class _SearchTab extends StatefulWidget {
  const _SearchTab();
  @override
  State<_SearchTab> createState() => _SearchTabState();
}

class _SearchTabState extends State<_SearchTab> {
  final _fromCtrl = TextEditingController();
  final _toCtrl = TextEditingController();
  DateTime? _date;
  bool _searching = false;
  List<dynamic> _results = [];
  bool _searched = false;

  @override
  void dispose() {
    _fromCtrl.dispose();
    _toCtrl.dispose();
    super.dispose();
  }

  Future<void> _search() async {
    final from = _fromCtrl.text.trim();
    final to = _toCtrl.text.trim();
    if (from.isEmpty || to.isEmpty) {
      ScaffoldMessenger.of(context).showSnackBar(const SnackBar(
        content: Text('Please enter both cities'),
        behavior: SnackBarBehavior.floating,
      ));
      return;
    }
    if (from.toLowerCase() == to.toLowerCase()) {
      ScaffoldMessenger.of(context).showSnackBar(const SnackBar(
        content: Text('Pickup and drop cities cannot be the same'),
        behavior: SnackBarBehavior.floating,
      ));
      return;
    }
    setState(() { _searching = true; _results = []; _searched = false; });
    try {
      final headers = await AuthService.getHeaders();
      final dateStr = _date != null ? DateFormat('yyyy-MM-dd').format(_date!) : '';
      final uri = Uri.parse(ApiConfig.outstationPoolSearch).replace(queryParameters: {
        'fromCity': from,
        'toCity': to,
        if (dateStr.isNotEmpty) 'date': dateStr,
      });
      final res = await http.get(uri, headers: headers).timeout(const Duration(seconds: 15));
      if (!mounted) return;
      if (res.statusCode == 401) {
        await AuthService.handle401();
        return;
      }
      if (res.statusCode == 200) {
        final data = jsonDecode(res.body) as Map<String, dynamic>;
        setState(() { _results = data['data'] as List<dynamic>? ?? []; _searched = true; });
      } else {
        String msg = 'Could not fetch rides. Please try again.';
        try {
          final body = jsonDecode(res.body);
          msg = body['message']?.toString() ?? msg;
        } catch (_) {}
        setState(() => _searched = true);
        ScaffoldMessenger.of(context).showSnackBar(SnackBar(
          content: Text(msg),
          behavior: SnackBarBehavior.floating,
          backgroundColor: JT.error,
        ));
      }
    } catch (_) {
      if (mounted) {
        setState(() => _searched = true);
        ScaffoldMessenger.of(context).showSnackBar(const SnackBar(
          content: Text('Network error. Please try again.'),
          behavior: SnackBarBehavior.floating,
        ));
      }
    } finally {
      if (mounted) setState(() => _searching = false);
    }
  }

  Future<void> _pickDate() async {
    final d = await showDatePicker(
      context: context,
      initialDate: _date ?? DateTime.now(),
      firstDate: DateTime.now(),
      lastDate: DateTime.now().add(const Duration(days: 90)),
      builder: (ctx, child) => Theme(
        data: Theme.of(ctx).copyWith(
          colorScheme: ColorScheme.light(primary: JT.primary),
        ),
        child: child!,
      ),
    );
    if (d != null) setState(() => _date = d);
  }

  @override
  Widget build(BuildContext context) {
    return ListView(
      padding: const EdgeInsets.all(16),
      children: [
        // Search card
        Container(
          padding: const EdgeInsets.all(16),
          decoration: BoxDecoration(
            color: Colors.white,
            borderRadius: BorderRadius.circular(16),
            boxShadow: JT.cardShadow,
          ),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text('Find a Pool Ride', style: TextStyle(fontSize: 16, fontWeight: FontWeight.w500, color: JT.textPrimary)),
              const SizedBox(height: 14),
              TextField(
                controller: _fromCtrl,
                textInputAction: TextInputAction.next,
                decoration: _dec('From City', Icons.trip_origin_rounded),
              ),
              const SizedBox(height: 10),
              TextField(
                controller: _toCtrl,
                textInputAction: TextInputAction.done,
                onSubmitted: (_) => _search(),
                decoration: _dec('To City', Icons.location_on_rounded),
              ),
              const SizedBox(height: 10),
              GestureDetector(
                onTap: _pickDate,
                child: Container(
                  padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 14),
                  decoration: BoxDecoration(
                    border: Border.all(color: JT.border),
                    borderRadius: BorderRadius.circular(10),
                    color: JT.bgSoft,
                  ),
                  child: Row(
                    children: [
                      Icon(Icons.calendar_today_rounded, color: JT.primary, size: 18),
                      const SizedBox(width: 10),
                      Text(
                        _date != null ? DateFormat('dd MMM yyyy').format(_date!) : 'Any Date',
                        style: TextStyle(fontSize: 13, color: _date != null ? JT.textPrimary : JT.textSecondary),
                      ),
                      const Spacer(),
                      if (_date != null)
                        GestureDetector(
                          onTap: () => setState(() => _date = null),
                          child: Icon(Icons.clear_rounded, size: 18, color: JT.textSecondary),
                        ),
                    ],
                  ),
                ),
              ),
              const SizedBox(height: 14),
              SizedBox(
                width: double.infinity,
                child: JT.gradientButton(
                  label: 'Search Rides',
                  loading: _searching,
                  onTap: _search,
                ),
              ),
            ],
          ),
        ),

        const SizedBox(height: 20),

        if (_searching)
          const Center(child: Padding(padding: EdgeInsets.all(32), child: CircularProgressIndicator(color: JT.primary))),

        if (_searched && _results.isEmpty && !_searching)
          Center(
            child: Padding(
              padding: const EdgeInsets.all(32),
              child: Column(
                children: [
                  Icon(Icons.directions_car_rounded, size: 64, color: JT.textSecondary.withValues(alpha: 0.4)),
                  const SizedBox(height: 16),
                  Text('No rides found', style: TextStyle(fontSize: 16, color: JT.textSecondary)),
                  const SizedBox(height: 6),
                  Text('Try different cities or dates', style: TextStyle(fontSize: 12, color: JT.textSecondary)),
                ],
              ),
            ),
          ),

        ..._results.map((r) => _RideCard(ride: r as Map<String, dynamic>)),
      ],
    );
  }

  InputDecoration _dec(String label, IconData icon) => InputDecoration(
    labelText: label,
    prefixIcon: Icon(icon, color: JT.primary, size: 18),
    border: OutlineInputBorder(borderRadius: BorderRadius.circular(10), borderSide: BorderSide(color: JT.border)),
    enabledBorder: OutlineInputBorder(borderRadius: BorderRadius.circular(10), borderSide: BorderSide(color: JT.border)),
    focusedBorder: OutlineInputBorder(borderRadius: BorderRadius.circular(10), borderSide: BorderSide(color: JT.primary, width: 1.5)),
    filled: true,
    fillColor: JT.bgSoft,
    contentPadding: const EdgeInsets.symmetric(horizontal: 12, vertical: 13),
    labelStyle: TextStyle(fontSize: 13, color: JT.textSecondary),
  );
}

// ── Ride Card ─────────────────────────────────────────────────────────────────

class _RideCard extends StatelessWidget {
  final Map<String, dynamic> ride;
  const _RideCard({required this.ride});

  @override
  Widget build(BuildContext context) {
    final seats = ride['availableSeats'] ?? ride['available_seats'] ?? 0;
    final fare = double.tryParse(ride['farePerSeat']?.toString() ?? ride['fare_per_seat']?.toString() ?? '0') ?? 0;
    final depDate = ride['departureDate']?.toString() ?? ride['departure_date']?.toString() ?? '';
    final depTime = ride['departureTime']?.toString() ?? ride['departure_time']?.toString() ?? '';
    final driverName = ride['driverName']?.toString() ?? ride['driver_name']?.toString() ?? 'Driver';
    final rating = double.tryParse(ride['driverRating']?.toString() ?? ride['driver_rating']?.toString() ?? '0') ?? 0;
    final vehicle = ride['vehicleModel']?.toString() ?? ride['vehicle_model']?.toString() ?? '';
    final vehicleNo = ride['vehicleNumber']?.toString() ?? ride['vehicle_number']?.toString() ?? '';

    String formattedDate = depDate;
    try {
      formattedDate = DateFormat('dd MMM yyyy').format(DateTime.parse(depDate));
    } catch (_) {}

    return Container(
      margin: const EdgeInsets.only(bottom: 12),
      decoration: BoxDecoration(
        color: Colors.white,
        borderRadius: BorderRadius.circular(16),
        boxShadow: JT.cardShadow,
      ),
      child: Column(
        children: [
          // Route header
          Container(
            padding: const EdgeInsets.all(14),
            decoration: BoxDecoration(
              gradient: JT.grad,
              borderRadius: const BorderRadius.vertical(top: Radius.circular(16)),
            ),
            child: Row(
              children: [
                const Icon(Icons.trip_origin_rounded, color: Colors.white70, size: 16),
                const SizedBox(width: 6),
                Expanded(
                  child: Text(
                    '${ride['fromCity'] ?? ride['from_city'] ?? ''} → ${ride['toCity'] ?? ride['to_city'] ?? ''}',
                    style: const TextStyle(color: Colors.white, fontWeight: FontWeight.w500, fontSize: 14),
                  ),
                ),
                Container(
                  padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 4),
                  decoration: BoxDecoration(
                    color: Colors.white.withValues(alpha: 0.2),
                    borderRadius: BorderRadius.circular(20),
                  ),
                  child: Text('₹${fare.toStringAsFixed(0)}/seat',
                      style: const TextStyle(color: Colors.white, fontWeight: FontWeight.w500, fontSize: 13)),
                ),
              ],
            ),
          ),

          // Details
          Padding(
            padding: const EdgeInsets.all(14),
            child: Column(
              children: [
                Row(
                  children: [
                    _infoChip(Icons.calendar_today_rounded, formattedDate),
                    const SizedBox(width: 8),
                    _infoChip(Icons.access_time_rounded, depTime),
                    const SizedBox(width: 8),
                    _infoChip(Icons.event_seat_rounded, '$seats seats left'),
                  ],
                ),
                const SizedBox(height: 10),
                Row(
                  children: [
                    CircleAvatar(
                      radius: 16,
                      backgroundColor: JT.primary.withValues(alpha: 0.1),
                      child: Text(driverName.isNotEmpty ? driverName[0].toUpperCase() : 'D',
                          style: TextStyle(color: JT.primary, fontWeight: FontWeight.w500, fontSize: 12)),
                    ),
                    const SizedBox(width: 8),
                    Expanded(
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Text(driverName, style: TextStyle(fontWeight: FontWeight.w400, color: JT.textPrimary, fontSize: 13)),
                          if (vehicle.isNotEmpty || vehicleNo.isNotEmpty)
                            Text('${vehicle.isNotEmpty ? vehicle : ''}${vehicleNo.isNotEmpty ? ' · $vehicleNo' : ''}',
                                style: TextStyle(fontSize: 11, color: JT.textSecondary)),
                        ],
                      ),
                    ),
                    if (rating > 0)
                      Row(
                        children: [
                          const Icon(Icons.star_rounded, size: 14, color: Colors.amber),
                          const SizedBox(width: 2),
                          Text(rating.toStringAsFixed(1),
                              style: TextStyle(fontSize: 12, fontWeight: FontWeight.w400, color: JT.textPrimary)),
                        ],
                      ),
                  ],
                ),
                const SizedBox(height: 12),
                SizedBox(
                  width: double.infinity,
                  child: ElevatedButton(
                    style: ElevatedButton.styleFrom(
                      backgroundColor: JT.primary,
                      foregroundColor: Colors.white,
                      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(10)),
                      padding: const EdgeInsets.symmetric(vertical: 11),
                    ),
                    onPressed: seats > 0
                        ? () => _showBookDialog(context, ride, fare, seats)
                        : null,
                    child: Text(seats > 0 ? 'Book Seat' : 'Fully Booked',
                        style: const TextStyle(fontWeight: FontWeight.w500)),
                  ),
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }

  Widget _infoChip(IconData icon, String label) => Expanded(
    child: Container(
      padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 6),
      decoration: BoxDecoration(
        color: JT.bgSoft,
        borderRadius: BorderRadius.circular(8),
      ),
      child: Row(
        children: [
          Icon(icon, size: 12, color: JT.primary),
          const SizedBox(width: 4),
          Flexible(child: Text(label, style: TextStyle(fontSize: 10, color: JT.textSecondary), overflow: TextOverflow.ellipsis)),
        ],
      ),
    ),
  );

  Future<void> _showBookDialog(BuildContext context, Map<String, dynamic> ride, double farePerSeat, int maxSeats) async {
    final booking = await showModalBottomSheet<Map<String, dynamic>>(
      context: context,
      isScrollControlled: true,
      backgroundColor: Colors.transparent,
      builder: (_) => _BookBottomSheet(ride: ride, farePerSeat: farePerSeat, maxSeats: maxSeats),
    );
    if (!context.mounted || booking == null) return;
    final bookingId = booking['id']?.toString() ?? '';
    if (bookingId.isEmpty) return;
    await Navigator.push(
      context,
      MaterialPageRoute(
        builder: (_) => OutstationPoolBookingDetailScreen(
          bookingId: bookingId,
          initialBooking: booking,
        ),
      ),
    );
  }
}

// ── Book Bottom Sheet ─────────────────────────────────────────────────────────

class _BookBottomSheet extends StatefulWidget {
  final Map<String, dynamic> ride;
  final double farePerSeat;
  final int maxSeats;
  const _BookBottomSheet({required this.ride, required this.farePerSeat, required this.maxSeats});
  @override
  State<_BookBottomSheet> createState() => _BookBottomSheetState();
}

class _BookBottomSheetState extends State<_BookBottomSheet> {
  int _seats = 1;
  String _paymentMethod = 'cash';
  final _pickupCtrl = TextEditingController();
  final _dropCtrl = TextEditingController();
  bool _booking = false;

  int get _maxSelectableSeats => widget.maxSeats < 2 ? widget.maxSeats : 2;

  double? _num(dynamic value) {
    if (value == null) return null;
    if (value is num) return value.toDouble();
    return double.tryParse(value.toString());
  }

  @override
  void dispose() {
    _pickupCtrl.dispose();
    _dropCtrl.dispose();
    super.dispose();
  }

  Future<void> _book() async {
    if (_seats < 1 || _seats > _maxSelectableSeats) {
      ScaffoldMessenger.of(context).showSnackBar(const SnackBar(
        content: Text('Choose 1 or 2 seats only'),
        behavior: SnackBarBehavior.floating,
      ));
      return;
    }
    final rideId = widget.ride['id']?.toString() ?? '';
    if (rideId.isEmpty) {
      ScaffoldMessenger.of(context).showSnackBar(const SnackBar(
        content: Text('Ride unavailable. Please refresh and try again.'),
        behavior: SnackBarBehavior.floating,
      ));
      return;
    }
    final pickupLat = _num(widget.ride['fromLat'] ?? widget.ride['from_lat']);
    final pickupLng = _num(widget.ride['fromLng'] ?? widget.ride['from_lng']);
    final dropLat = _num(widget.ride['toLat'] ?? widget.ride['to_lat']);
    final dropLng = _num(widget.ride['toLng'] ?? widget.ride['to_lng']);
    if (pickupLat == null || pickupLng == null || dropLat == null || dropLng == null) {
      ScaffoldMessenger.of(context).showSnackBar(const SnackBar(
        content: Text('Route coordinates unavailable. Please refresh rides and try again.'),
        behavior: SnackBarBehavior.floating,
      ));
      return;
    }
    setState(() => _booking = true);
    try {
      final headers = await AuthService.getHeaders();
      final res = await http.post(
        Uri.parse(ApiConfig.outstationPoolBook),
        headers: {...headers, 'Content-Type': 'application/json'},
        body: jsonEncode({
          'rideId': rideId,
          'seatsBooked': _seats,
          'paymentMethod': _paymentMethod,
          'pickupLat': pickupLat,
          'pickupLng': pickupLng,
          'dropLat': dropLat,
          'dropLng': dropLng,
          'pickupAddress': _pickupCtrl.text.trim().isNotEmpty
              ? _pickupCtrl.text.trim()
              : (widget.ride['fromCity']?.toString() ?? widget.ride['from_city']?.toString() ?? 'Pickup point'),
          'dropoffAddress': _dropCtrl.text.trim().isNotEmpty
              ? _dropCtrl.text.trim()
              : (widget.ride['toCity']?.toString() ?? widget.ride['to_city']?.toString() ?? 'Drop point'),
        }),
      ).timeout(const Duration(seconds: 15));

      if (!mounted) return;
      if (res.statusCode == 401) {
        await AuthService.handle401();
        return;
      }
      final body = jsonDecode(res.body) as Map<String, dynamic>;
      if (res.statusCode == 200 && body['success'] == true) {
        final booking = body['booking'];
        Navigator.of(context).pop(
          booking is Map<String, dynamic> ? booking : null,
        );
        final totalFare = body['totalFare'];
        final bookingMessage = body['message']?.toString() ?? 'Booking confirmed!';
        ScaffoldMessenger.of(context).showSnackBar(SnackBar(
          content: Text(
            totalFare != null
                ? 'Booking confirmed · ₹${double.tryParse(totalFare.toString())?.toStringAsFixed(0) ?? totalFare} · $bookingMessage'
                : bookingMessage,
          ),
          backgroundColor: Colors.green,
          behavior: SnackBarBehavior.floating,
        ));
      } else {
        ScaffoldMessenger.of(context).showSnackBar(SnackBar(
          content: Text(body['message'] ?? 'Booking failed'),
          backgroundColor: JT.error,
          behavior: SnackBarBehavior.floating,
        ));
      }
    } catch (_) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(const SnackBar(
          content: Text('Network error. Please try again.'),
          behavior: SnackBarBehavior.floating,
        ));
      }
    } finally {
      if (mounted) setState(() => _booking = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final total = widget.farePerSeat * _seats;
    return Container(
      decoration: const BoxDecoration(
        color: Colors.white,
        borderRadius: BorderRadius.vertical(top: Radius.circular(24)),
      ),
      padding: EdgeInsets.fromLTRB(20, 8, 20, MediaQuery.of(context).viewInsets.bottom + 20),
      child: SingleChildScrollView(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Center(
              child: Container(
                width: 40, height: 4,
                margin: const EdgeInsets.only(bottom: 16),
                decoration: BoxDecoration(color: Colors.grey[300], borderRadius: BorderRadius.circular(2)),
              ),
            ),
            Text('Confirm Booking', style: TextStyle(fontSize: 18, fontWeight: FontWeight.w500, color: JT.textPrimary)),
            const SizedBox(height: 4),
            Text(
              '${widget.ride['fromCity'] ?? widget.ride['from_city'] ?? ''} → ${widget.ride['toCity'] ?? widget.ride['to_city'] ?? ''}',
              style: TextStyle(fontSize: 13, color: JT.textSecondary),
            ),
            const SizedBox(height: 20),

            // Seats selector
            Row(
              children: [
                Text('Number of Seats', style: TextStyle(fontSize: 13, fontWeight: FontWeight.w600, color: JT.textPrimary)),
                const Spacer(),
                Container(
                  padding: const EdgeInsets.symmetric(horizontal: 9, vertical: 4),
                  decoration: BoxDecoration(
                    color: JT.primary.withValues(alpha: 0.08),
                    borderRadius: BorderRadius.circular(999),
                  ),
                  child: Text('Max 2 per person', style: TextStyle(fontSize: 10.5, fontWeight: FontWeight.w600, color: JT.primary)),
                ),
              ],
            ),
            const SizedBox(height: 8),
            Row(
              children: [
                _seatBtn(Icons.remove_rounded, () {
                  if (_seats > 1) setState(() => _seats--);
                }),
                Padding(
                  padding: const EdgeInsets.symmetric(horizontal: 20),
                  child: Text('$_seats', style: TextStyle(fontSize: 20, fontWeight: FontWeight.w500, color: JT.textPrimary)),
                ),
                _seatBtn(Icons.add_rounded, () {
                  if (_seats < _maxSelectableSeats) setState(() => _seats++);
                }),
                const Spacer(),
                Text(
                  '₹${total.toStringAsFixed(0)} total',
                  style: TextStyle(fontSize: 18, fontWeight: FontWeight.w500, color: JT.primary),
                ),
              ],
            ),

            const SizedBox(height: 14),
            Container(
              width: double.infinity,
              padding: const EdgeInsets.all(14),
              decoration: BoxDecoration(
                color: JT.bgSoft,
                borderRadius: BorderRadius.circular(16),
                border: Border.all(color: JT.border),
              ),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    'Seat Availability',
                    style: TextStyle(
                      fontSize: 13,
                      fontWeight: FontWeight.w600,
                      color: JT.textPrimary,
                    ),
                  ),
                  const SizedBox(height: 10),
                  Wrap(
                    spacing: 10,
                    runSpacing: 10,
                    children: List.generate(widget.maxSeats, (index) {
                      final isSelectable = index < _maxSelectableSeats;
                      final isSelected = index < _seats;
                      return _seatStatusChip(
                        label: 'S${index + 1}',
                        subtitle: isSelected
                            ? 'Selected'
                            : isSelectable
                                ? 'Open'
                                : 'Reserved',
                        color: isSelected
                            ? JT.primary
                            : isSelectable
                                ? JT.success
                                : JT.textTertiary,
                      );
                    }),
                  ),
                ],
              ),
            ),

            const SizedBox(height: 16),

            // Optional pickup/drop addresses
            TextField(
              controller: _pickupCtrl,
              decoration: _inputDec('Pickup Address (optional)', Icons.trip_origin_rounded),
              textInputAction: TextInputAction.next,
            ),
            const SizedBox(height: 10),
            TextField(
              controller: _dropCtrl,
              decoration: _inputDec('Drop Address (optional)', Icons.location_on_rounded),
              textInputAction: TextInputAction.done,
            ),

            const SizedBox(height: 16),

            // Payment method
            Text('Payment Method', style: TextStyle(fontSize: 13, fontWeight: FontWeight.w400, color: JT.textPrimary)),
            const SizedBox(height: 8),
            Row(
              children: [
                _payBtn('cash', Icons.money_rounded, 'Cash'),
                const SizedBox(width: 10),
                _payBtn('wallet', Icons.account_balance_wallet_rounded, 'Wallet'),
                const SizedBox(width: 10),
                _payBtn('upi', Icons.payment_rounded, 'UPI'),
              ],
            ),

            const SizedBox(height: 20),

            SizedBox(
              width: double.infinity,
              child: JT.gradientButton(
                label: 'Confirm Booking · ₹${total.toStringAsFixed(0)}',
                loading: _booking,
                onTap: _book,
              ),
            ),
          ],
        ),
      ),
    );
  }

  Widget _seatBtn(IconData icon, VoidCallback onTap) => GestureDetector(
    onTap: onTap,
    child: Container(
      width: 36, height: 36,
      decoration: BoxDecoration(
        color: JT.primary.withValues(alpha: 0.1),
        shape: BoxShape.circle,
      ),
      child: Icon(icon, color: JT.primary, size: 18),
    ),
  );

  Widget _seatStatusChip({
    required String label,
    required String subtitle,
    required Color color,
  }) {
    return Container(
      width: 84,
      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 12),
      decoration: BoxDecoration(
        color: color.withValues(alpha: 0.08),
        borderRadius: BorderRadius.circular(14),
        border: Border.all(color: color.withValues(alpha: 0.16)),
      ),
      child: Column(
        children: [
          Icon(Icons.event_seat_rounded, size: 18, color: color),
          const SizedBox(height: 6),
          Text(
            label,
            style: TextStyle(
              fontSize: 12,
              fontWeight: FontWeight.w600,
              color: JT.textPrimary,
            ),
          ),
          const SizedBox(height: 2),
          Text(
            subtitle,
            style: TextStyle(
              fontSize: 10.5,
              color: JT.textSecondary,
            ),
          ),
        ],
      ),
    );
  }

  Widget _payBtn(String value, IconData icon, String label) => Expanded(
    child: GestureDetector(
      onTap: () => setState(() => _paymentMethod = value),
      child: Container(
        padding: const EdgeInsets.symmetric(vertical: 10),
        decoration: BoxDecoration(
          color: _paymentMethod == value ? JT.primary : Colors.transparent,
          border: Border.all(color: _paymentMethod == value ? JT.primary : JT.border),
          borderRadius: BorderRadius.circular(10),
        ),
        child: Column(
          children: [
            Icon(icon, size: 18, color: _paymentMethod == value ? Colors.white : JT.textSecondary),
            const SizedBox(height: 2),
            Text(label, style: TextStyle(fontSize: 10, fontWeight: FontWeight.w400,
                color: _paymentMethod == value ? Colors.white : JT.textSecondary)),
          ],
        ),
      ),
    ),
  );

  InputDecoration _inputDec(String label, IconData icon) => InputDecoration(
    labelText: label,
    prefixIcon: Icon(icon, color: JT.primary, size: 18),
    border: OutlineInputBorder(borderRadius: BorderRadius.circular(10), borderSide: BorderSide(color: JT.border)),
    enabledBorder: OutlineInputBorder(borderRadius: BorderRadius.circular(10), borderSide: BorderSide(color: JT.border)),
    focusedBorder: OutlineInputBorder(borderRadius: BorderRadius.circular(10), borderSide: BorderSide(color: JT.primary, width: 1.5)),
    filled: true, fillColor: JT.bgSoft,
    contentPadding: const EdgeInsets.symmetric(horizontal: 12, vertical: 12),
    labelStyle: TextStyle(fontSize: 12, color: JT.textSecondary),
  );
}

// ── My Bookings Tab ───────────────────────────────────────────────────────────

class _BookingsTab extends StatefulWidget {
  const _BookingsTab();
  @override
  State<_BookingsTab> createState() => _BookingsTabState();
}

class _BookingsTabState extends State<_BookingsTab> {
  bool _loading = true;
  List<dynamic> _bookings = [];

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    setState(() => _loading = true);
    try {
      final headers = await AuthService.getHeaders();
      final res = await http.get(
        Uri.parse(ApiConfig.outstationPoolBookings),
        headers: headers,
      ).timeout(const Duration(seconds: 15));
      if (!mounted) return;
      if (res.statusCode == 401) {
        await AuthService.handle401();
        return;
      }
      if (res.statusCode == 200) {
        final data = jsonDecode(res.body) as Map<String, dynamic>;
        setState(() { _bookings = data['data'] as List<dynamic>? ?? []; });
      } else {
        String msg = 'Unable to load bookings';
        try {
          msg = (jsonDecode(res.body) as Map<String, dynamic>)['message']?.toString() ?? msg;
        } catch (_) {}
        ScaffoldMessenger.of(context).showSnackBar(SnackBar(
          content: Text(msg),
          behavior: SnackBarBehavior.floating,
          backgroundColor: JT.error,
        ));
      }
    } catch (_) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(const SnackBar(
          content: Text('Network error. Pull to retry.'),
          behavior: SnackBarBehavior.floating,
        ));
      }
    }
    if (mounted) setState(() => _loading = false);
  }

  Color _statusColor(String? s) {
    switch (s) {
      case 'confirmed': return Colors.green;
      case 'cancelled': return JT.error;
      case 'completed': return JT.primary;
      default: return JT.textSecondary;
    }
  }

  @override
  Widget build(BuildContext context) {
    if (_loading) return const Center(child: CircularProgressIndicator(color: JT.primary));

    if (_bookings.isEmpty) {
      return Center(
        child: Padding(
          padding: const EdgeInsets.all(32),
          child: Column(
            mainAxisAlignment: MainAxisAlignment.center,
            children: [
              Icon(Icons.confirmation_number_rounded, size: 64, color: JT.textSecondary.withValues(alpha: 0.4)),
              const SizedBox(height: 16),
              Text('No bookings yet', style: TextStyle(fontSize: 16, color: JT.textSecondary)),
              const SizedBox(height: 6),
              Text('Book a pool ride to see it here', style: TextStyle(fontSize: 12, color: JT.textSecondary)),
            ],
          ),
        ),
      );
    }

    return RefreshIndicator(
      onRefresh: _load,
      color: JT.primary,
      child: ListView.builder(
        padding: const EdgeInsets.all(16),
        itemCount: _bookings.length,
        itemBuilder: (_, i) {
          final b = _bookings[i] as Map<String, dynamic>;
          final status = b['status']?.toString() ?? '';
          final seats = b['seatsBooked'] ?? b['seats_booked'] ?? 1;
          final fare = double.tryParse(b['totalFare']?.toString() ?? b['total_fare']?.toString() ?? '0') ?? 0;
          final from = b['fromCity']?.toString() ?? b['from_city']?.toString() ?? '';
          final to = b['toCity']?.toString() ?? b['to_city']?.toString() ?? '';
          final depDate = b['departureDate']?.toString() ?? b['departure_date']?.toString() ?? '';
          final depTime = b['departureTime']?.toString() ?? b['departure_time']?.toString() ?? '';
          final driverName = b['driverName']?.toString() ?? b['driver_name']?.toString() ?? '';
          final createdAt = b['createdAt']?.toString() ?? b['created_at']?.toString() ?? '';

          String formattedDate = depDate;
          try { formattedDate = DateFormat('dd MMM yyyy').format(DateTime.parse(depDate)); } catch (_) {}
          String formattedCreated = '';
          try { formattedCreated = DateFormat('dd MMM, h:mm a').format(DateTime.parse(createdAt).toLocal()); } catch (_) {}

          return GestureDetector(
            onTap: () => Navigator.push(
              context,
              MaterialPageRoute(
                builder: (_) => OutstationPoolBookingDetailScreen(
                  bookingId: b['id']?.toString() ?? '',
                  initialBooking: b,
                ),
              ),
            ),
            child: Container(
            margin: const EdgeInsets.only(bottom: 12),
            padding: const EdgeInsets.all(14),
            decoration: BoxDecoration(
              color: Colors.white,
              borderRadius: BorderRadius.circular(16),
              boxShadow: JT.cardShadow,
            ),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Row(
                  children: [
                    Expanded(
                      child: Text('$from → $to',
                          style: TextStyle(fontWeight: FontWeight.w500, fontSize: 14, color: JT.textPrimary)),
                    ),
                    Container(
                      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 4),
                      decoration: BoxDecoration(
                        color: _statusColor(status).withValues(alpha: 0.1),
                        borderRadius: BorderRadius.circular(20),
                      ),
                      child: Text(status.toUpperCase(),
                          style: TextStyle(fontSize: 10, fontWeight: FontWeight.w500, color: _statusColor(status))),
                    ),
                  ],
                ),
                const SizedBox(height: 8),
                Row(
                  children: [
                    Icon(Icons.calendar_today_rounded, size: 13, color: JT.textSecondary),
                    const SizedBox(width: 4),
                    Text('$formattedDate${depTime.isNotEmpty ? ' at $depTime' : ''}',
                        style: TextStyle(fontSize: 12, color: JT.textSecondary)),
                  ],
                ),
                const SizedBox(height: 4),
                Row(
                  children: [
                    Icon(Icons.event_seat_rounded, size: 13, color: JT.textSecondary),
                    const SizedBox(width: 4),
                    Text('$seats seat${seats == 1 ? '' : 's'} · ₹${fare.toStringAsFixed(0)}',
                        style: TextStyle(fontSize: 12, color: JT.textSecondary)),
                    if (driverName.isNotEmpty) ...[
                      const SizedBox(width: 10),
                      Icon(Icons.person_rounded, size: 13, color: JT.textSecondary),
                      const SizedBox(width: 4),
                      Text(driverName, style: TextStyle(fontSize: 12, color: JT.textSecondary)),
                    ],
                  ],
                ),
                if (formattedCreated.isNotEmpty) ...[
                  const SizedBox(height: 4),
                  Text('Booked: $formattedCreated', style: TextStyle(fontSize: 11, color: JT.textSecondary.withValues(alpha: 0.7))),
                ],
              ],
            ),
          ),
          );
        },
      ),
    );
  }
}

class OutstationPoolBookingDetailScreen extends StatefulWidget {
  final String bookingId;
  final Map<String, dynamic>? initialBooking;

  const OutstationPoolBookingDetailScreen({
    super.key,
    required this.bookingId,
    this.initialBooking,
  });

  @override
  State<OutstationPoolBookingDetailScreen> createState() =>
      _OutstationPoolBookingDetailScreenState();
}

class _OutstationPoolBookingDetailScreenState
    extends State<OutstationPoolBookingDetailScreen> {
  final SocketService _socket = SocketService();
  Map<String, dynamic>? _booking;
  bool _loading = true;
  String? _error;
  StreamSubscription<Map<String, dynamic>>? _callIncomingSub;
  StreamSubscription<Map<String, dynamic>>? _driverLocationSub;
  StreamSubscription<Map<String, dynamic>>? _seatUpdateSub;
  StreamSubscription<Map<String, dynamic>>? _poolStatusSub;
  StreamSubscription<Map<String, dynamic>>? _refundUpdateSub;
  StreamSubscription<Map<String, dynamic>>? _safetyUpdateSub;
  LatLng? _driverLatLng;

  @override
  void initState() {
    super.initState();
    _booking = widget.initialBooking;
    _callIncomingSub = _socket.onCallIncoming.listen((event) {
      final scope = event['callScope']?.toString();
      final poolModule = event['poolModule']?.toString();
      final referenceId = event['tripId']?.toString() ?? '';
      if (scope != 'pool' || poolModule != 'outstation_pool' || referenceId != widget.bookingId || !mounted) return;
      final callerId = event['callerId']?.toString() ?? '';
      Navigator.of(context).push(
        MaterialPageRoute(
          builder: (_) => CallScreen(
            contactName: event['callerName']?.toString() ?? 'Driver',
            tripId: widget.bookingId,
            targetUserId: callerId,
            isIncoming: true,
            callerIdForIncoming: callerId,
            callScope: 'pool',
            poolModule: 'outstation_pool',
          ),
        ),
      );
    });
    _driverLocationSub = _socket.onPoolDriverLocation.listen((event) {
      if ((event['module']?.toString() ?? '') != 'outstation_pool') return;
      final rideId = event['rideId']?.toString() ?? '';
      final bookingRideId = _booking?['rideId']?.toString() ?? _booking?['ride_id']?.toString() ?? '';
      if (rideId.isNotEmpty && bookingRideId.isNotEmpty && rideId != bookingRideId) return;
      final lat = double.tryParse('${event['lat'] ?? ''}');
      final lng = double.tryParse('${event['lng'] ?? ''}');
      if (lat == null || lng == null || !mounted) return;
      setState(() => _driverLatLng = LatLng(lat, lng));
    });
    _seatUpdateSub = _socket.onPoolSeatUpdate.listen((event) {
      if ((event['module']?.toString() ?? '') != 'outstation_pool' || !mounted) return;
      final rideId = event['rideId']?.toString() ?? '';
      final bookingRideId = _booking?['rideId']?.toString() ?? _booking?['ride_id']?.toString() ?? '';
      if (rideId.isNotEmpty && bookingRideId.isNotEmpty && rideId != bookingRideId) return;
      _load();
    });
    _poolStatusSub = _socket.onPoolStatus.listen((event) {
      if ((event['module']?.toString() ?? '') != 'outstation_pool' || !mounted) return;
      final referenceId = event['referenceId']?.toString() ?? event['bookingId']?.toString() ?? '';
      if (referenceId.isNotEmpty && referenceId != widget.bookingId) return;
      final nextStatus = event['status']?.toString() ?? '';
      if (_booking != null && nextStatus.isNotEmpty) {
        setState(() {
          _booking = {
            ..._booking!,
            'status': nextStatus,
            if (event['refundAmount'] != null) 'refundAmount': event['refundAmount'],
            if (event['refundStatus'] != null) 'refundStatus': event['refundStatus'],
          };
        });
      }
      _load();
    });
    _refundUpdateSub = _socket.onPoolRefundUpdated.listen((event) {
      if ((event['module']?.toString() ?? '') != 'outstation_pool' || !mounted) return;
      final referenceId = event['referenceId']?.toString() ?? event['bookingId']?.toString() ?? '';
      if (referenceId != widget.bookingId) return;
      _load();
    });
    _safetyUpdateSub = _socket.onPoolSafetyUpdated.listen((event) {
      if ((event['module']?.toString() ?? '') != 'outstation_pool' || !mounted) return;
      final referenceId = event['referenceId']?.toString() ?? '';
      if (referenceId != widget.bookingId) return;
      _load();
    });
    _load();
  }

  @override
  void dispose() {
    _callIncomingSub?.cancel();
    _driverLocationSub?.cancel();
    _seatUpdateSub?.cancel();
    _poolStatusSub?.cancel();
    _refundUpdateSub?.cancel();
    _safetyUpdateSub?.cancel();
    super.dispose();
  }

  Future<void> _load() async {
    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      final headers = await AuthService.getHeaders();
      final res = await http.get(
        Uri.parse(ApiConfig.outstationPoolBookings),
        headers: headers,
      ).timeout(const Duration(seconds: 15));
      if (!mounted) return;
      if (res.statusCode == 401) {
        await AuthService.handle401();
        return;
      }
      if (res.statusCode != 200) {
        setState(() {
          _loading = false;
          _error = 'Could not load booking details.';
        });
        return;
      }
      final body = jsonDecode(res.body) as Map<String, dynamic>;
      final bookings = (body['data'] as List<dynamic>? ?? const [])
          .whereType<Map<String, dynamic>>()
          .toList();
      final match = bookings.cast<Map<String, dynamic>?>().firstWhere(
            (item) => item?['id']?.toString() == widget.bookingId,
            orElse: () => widget.initialBooking,
          );
      setState(() {
        _booking = match;
        final lat = double.tryParse('${match?['current_lat'] ?? ''}');
        final lng = double.tryParse('${match?['current_lng'] ?? ''}');
        if (lat != null && lng != null) {
          _driverLatLng = LatLng(lat, lng);
        }
        _loading = false;
        if (match == null) {
          _error = 'This booking is no longer available.';
        }
      });
    } catch (_) {
      if (!mounted) return;
      setState(() {
        _loading = false;
        _error = 'Network error while loading booking details.';
      });
    }
  }

  Color _statusColor(String status) {
    switch (status) {
      case 'confirmed':
        return JT.success;
      case 'cancelled':
        return JT.error;
      case 'dropped':
      case 'completed':
        return JT.primary;
      default:
        return JT.warning;
    }
  }

  String _statusMessage(String status) {
    switch (status) {
      case 'confirmed':
        return 'Your seat is confirmed. Keep this page handy for pickup readiness and support.';
      case 'dropped':
      case 'completed':
        return 'This pool trip is completed. You can review the booking summary or contact support.';
      case 'cancelled':
        return 'This booking was cancelled. If payment was already collected, support can help with refund follow-up.';
      default:
        return 'We are keeping your pooled booking details ready here.';
    }
  }

  String _paymentHint(String paymentMethod, String paymentStatus) {
    if (paymentStatus == 'paid') {
      return 'Payment is already settled through ${paymentMethod.toUpperCase()}.';
    }
    if (paymentMethod == 'cash') {
      return 'Pay the driver at boarding time and keep the receipt reference safe.';
    }
    return 'Payment is still pending. Contact support if the status does not update after pickup.';
  }

  Future<void> _openCancellationFlow() async {
    final booking = _booking;
    if (booking == null) return;
    final result = await Navigator.of(context).push(
      MaterialPageRoute(
        builder: (_) => PoolCancellationScreen(
          title: 'Cancel Pool Booking',
          bookingId: widget.bookingId,
          isOutstation: true,
          routeLabel:
              '${booking['fromCity'] ?? booking['from_city'] ?? ''} -> ${booking['toCity'] ?? booking['to_city'] ?? ''}',
          seatsBooked: int.tryParse('${booking['seatsBooked'] ?? booking['seats_booked'] ?? 1}') ?? 1,
          totalFare: double.tryParse(
                booking['totalFare']?.toString() ?? booking['total_fare']?.toString() ?? '0',
              ) ??
              0,
        ),
      ),
    );
    if (result is Map && mounted) {
      setState(() {
        _booking = {
          ...?_booking,
          'status': 'cancelled',
          if (result['refundAmount'] != null) 'refundAmount': result['refundAmount'],
        };
      });
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text(result['message']?.toString() ?? 'Booking cancelled')),
      );
    }
  }

  void _openPoolChat() {
    showModalBottomSheet(
      context: context,
      isScrollControlled: true,
      backgroundColor: Colors.transparent,
      builder: (_) => TripChatSheet(
        tripId: widget.bookingId,
        senderName: 'Customer',
        chatScope: 'pool',
        poolModule: 'outstation_pool',
        title: 'Pool Chat',
      ),
    );
  }

  void _startPoolCall(String driverName, String driverId) {
    if (driverId.isEmpty) {
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('Driver call is not available right now')),
      );
      return;
    }
    Navigator.of(context).push(
      MaterialPageRoute(
        builder: (_) => CallScreen(
          contactName: driverName.isEmpty ? 'Driver' : driverName,
          tripId: widget.bookingId,
          targetUserId: driverId,
          callScope: 'pool',
          poolModule: 'outstation_pool',
        ),
      ),
    );
  }

  Widget _infoTile(IconData icon, String label, String value) {
    return Container(
      padding: const EdgeInsets.all(14),
      decoration: BoxDecoration(
        color: Colors.white,
        borderRadius: BorderRadius.circular(16),
        boxShadow: JT.cardShadow,
      ),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Container(
            width: 38,
            height: 38,
            decoration: BoxDecoration(
              color: JT.primary.withValues(alpha: 0.1),
              borderRadius: BorderRadius.circular(12),
            ),
            child: Icon(icon, color: JT.primary, size: 18),
          ),
          const SizedBox(width: 12),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(label, style: JT.caption.copyWith(color: JT.textSecondary)),
                const SizedBox(height: 4),
                Text(value.isEmpty ? 'Not available yet' : value, style: JT.bodyPrimary),
              ],
            ),
          ),
        ],
      ),
    );
  }

  Widget _actionChip({
    required IconData icon,
    required String label,
    required VoidCallback onTap,
  }) {
    return InkWell(
      onTap: onTap,
      borderRadius: BorderRadius.circular(14),
      child: Ink(
        padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 12),
        decoration: BoxDecoration(
          color: JT.surfaceAlt,
          borderRadius: BorderRadius.circular(14),
          border: Border.all(color: JT.border),
        ),
        child: Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            Icon(icon, color: JT.primary, size: 18),
            const SizedBox(width: 8),
            Text(label, style: JT.caption.copyWith(color: JT.textPrimary, fontWeight: FontWeight.w600)),
          ],
        ),
      ),
    );
  }

  Widget _liveMapCard() {
    final booking = _booking;
    final pickupLat = double.tryParse('${booking?['pickup_lat'] ?? ''}');
    final pickupLng = double.tryParse('${booking?['pickup_lng'] ?? ''}');
    final dropLat = double.tryParse('${booking?['drop_lat'] ?? ''}');
    final dropLng = double.tryParse('${booking?['drop_lng'] ?? ''}');
    final pickup = (pickupLat != null && pickupLng != null) ? LatLng(pickupLat, pickupLng) : null;
    final drop = (dropLat != null && dropLng != null) ? LatLng(dropLat, dropLng) : null;
    final center = _driverLatLng ?? pickup ?? drop;
    if (center == null) {
      return _infoTile(
        Icons.map_rounded,
        'Live Movement',
        'Driver live map will appear once route GPS starts syncing.',
      );
    }

    final markers = <Marker>{
      if (pickup != null)
        Marker(
          markerId: const MarkerId('pickup'),
          position: pickup,
          infoWindow: const InfoWindow(title: 'Pickup'),
          icon: BitmapDescriptor.defaultMarkerWithHue(BitmapDescriptor.hueAzure),
        ),
      if (drop != null)
        Marker(
          markerId: const MarkerId('drop'),
          position: drop,
          infoWindow: const InfoWindow(title: 'Drop'),
          icon: BitmapDescriptor.defaultMarkerWithHue(BitmapDescriptor.hueRed),
        ),
      if (_driverLatLng != null)
        Marker(
          markerId: const MarkerId('driver'),
          position: _driverLatLng!,
          infoWindow: const InfoWindow(title: 'Driver'),
          icon: BitmapDescriptor.defaultMarkerWithHue(BitmapDescriptor.hueGreen),
        ),
    };

    return Container(
      padding: const EdgeInsets.all(14),
      decoration: BoxDecoration(
        color: Colors.white,
        borderRadius: BorderRadius.circular(16),
        boxShadow: JT.cardShadow,
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Container(
                width: 38,
                height: 38,
                decoration: BoxDecoration(
                  color: JT.primary.withValues(alpha: 0.1),
                  borderRadius: BorderRadius.circular(12),
                ),
                child: const Icon(Icons.map_rounded, color: JT.primary, size: 18),
              ),
              const SizedBox(width: 12),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text('Live Movement', style: JT.bodyPrimary),
                    const SizedBox(height: 4),
                    Text(
                      _driverLatLng == null
                          ? 'Waiting for driver GPS update.'
                          : 'Driver position is syncing live for this pool trip.',
                      style: JT.caption.copyWith(color: JT.textSecondary),
                    ),
                  ],
                ),
              ),
            ],
          ),
          const SizedBox(height: 12),
          ClipRRect(
            borderRadius: BorderRadius.circular(14),
            child: SizedBox(
              height: 200,
              child: GoogleMap(
                initialCameraPosition: CameraPosition(target: center, zoom: 12.8),
                markers: markers,
                myLocationEnabled: false,
                myLocationButtonEnabled: false,
                zoomControlsEnabled: false,
                compassEnabled: false,
              ),
            ),
          ),
        ],
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final booking = _booking;
    final status = booking?['status']?.toString() ?? 'pending';
    final paymentMethod =
        booking?['paymentMethod']?.toString() ?? booking?['payment_method']?.toString() ?? 'cash';
    final paymentStatus =
        booking?['paymentStatus']?.toString() ?? booking?['payment_status']?.toString() ?? 'pending';
    final fare = double.tryParse(
          booking?['totalFare']?.toString() ?? booking?['total_fare']?.toString() ?? '0',
        ) ??
        0;
    final seats =
        int.tryParse('${booking?['seatsBooked'] ?? booking?['seats_booked'] ?? 1}') ?? 1;
    final route =
        '${booking?['fromCity'] ?? booking?['from_city'] ?? ''} → ${booking?['toCity'] ?? booking?['to_city'] ?? ''}';
    final driverName =
        booking?['driverName']?.toString() ?? booking?['driver_name']?.toString() ?? '';
    final driverPhone =
        booking?['driverPhone']?.toString() ?? booking?['driver_phone']?.toString() ?? '';
    final departureDate =
        booking?['departureDate']?.toString() ?? booking?['departure_date']?.toString() ?? '';
    final departureTime =
        booking?['departureTime']?.toString() ?? booking?['departure_time']?.toString() ?? '';
    final pickupAddress =
        booking?['pickupAddress']?.toString() ?? booking?['pickup_address']?.toString() ?? '';
    final dropoffAddress =
        booking?['dropoffAddress']?.toString() ?? booking?['dropoff_address']?.toString() ?? '';
    final driverSafety = booking?['driverSafety'] is Map<String, dynamic>
        ? booking!['driverSafety'] as Map<String, dynamic>
        : null;
    final driverSafetyLabel = driverSafety?['badgeLabel']?.toString();
    final driverId =
        booking?['driverId']?.toString() ?? booking?['driver_id']?.toString() ?? '';

    return Scaffold(
      backgroundColor: JT.bgSoft,
      appBar: AppBar(
        backgroundColor: Colors.white,
        elevation: 0,
        surfaceTintColor: Colors.transparent,
        title: Text('Pool Booking', style: JT.h5),
      ),
      body: _loading
          ? const Center(child: CircularProgressIndicator(color: JT.primary))
          : _error != null
              ? Center(
                  child: Padding(
                    padding: const EdgeInsets.all(24),
                    child: Column(
                      mainAxisSize: MainAxisSize.min,
                      children: [
                        const Icon(Icons.cloud_off_rounded, size: 50, color: JT.textSecondary),
                        const SizedBox(height: 12),
                        Text(_error!, textAlign: TextAlign.center, style: JT.body),
                        const SizedBox(height: 16),
                        JT.gradientButton(label: 'Retry', onTap: _load),
                      ],
                    ),
                  ),
                )
              : RefreshIndicator(
                  onRefresh: _load,
                  color: JT.primary,
                  child: ListView(
                    padding: const EdgeInsets.fromLTRB(16, 16, 16, 28),
                    children: [
                      Container(
                        padding: const EdgeInsets.all(18),
                        decoration: BoxDecoration(
                          gradient: JT.grad,
                          borderRadius: BorderRadius.circular(22),
                          boxShadow: JT.btnShadowHover,
                        ),
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            Container(
                              padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 5),
                              decoration: BoxDecoration(
                                color: Colors.white.withValues(alpha: 0.16),
                                borderRadius: BorderRadius.circular(999),
                              ),
                              child: Text(
                                status.toUpperCase(),
                                style: JT.caption.copyWith(
                                  color: Colors.white,
                                  fontWeight: FontWeight.w600,
                                ),
                              ),
                            ),
                            const SizedBox(height: 14),
                            Text(route, style: JT.h4.copyWith(color: Colors.white)),
                            const SizedBox(height: 6),
                            Text(
                              _statusMessage(status),
                              style: JT.smallText.copyWith(color: Colors.white.withValues(alpha: 0.92)),
                            ),
                          ],
                        ),
                      ),
                      const SizedBox(height: 14),
                      Row(
                        children: [
                          Expanded(child: _infoTile(Icons.event_seat_rounded, 'Seats', '$seats booked')),
                          const SizedBox(width: 12),
                          Expanded(child: _infoTile(Icons.currency_rupee_rounded, 'Total Fare', '₹${fare.toStringAsFixed(0)}')),
                        ],
                      ),
                      const SizedBox(height: 12),
                      _infoTile(
                        Icons.calendar_today_rounded,
                        'Departure',
                        '${departureDate.isEmpty ? 'TBD' : departureDate}${departureTime.isNotEmpty ? ' • $departureTime' : ''}',
                      ),
                      const SizedBox(height: 12),
                      _infoTile(Icons.trip_origin_rounded, 'Pickup Point', pickupAddress),
                      const SizedBox(height: 12),
                      _infoTile(Icons.location_on_rounded, 'Drop Point', dropoffAddress),
                      const SizedBox(height: 12),
                      _liveMapCard(),
                      const SizedBox(height: 12),
                      _infoTile(
                        Icons.person_rounded,
                        'Driver',
                        driverName.isEmpty
                            ? 'Driver details will appear once assigned.'
                            : '$driverName${driverPhone.isNotEmpty ? ' • $driverPhone' : ''}',
                      ),
                      if (driverSafetyLabel != null) ...[
                        const SizedBox(height: 12),
                        _safetyNotice(driverSafetyLabel),
                      ],
                      if (status == 'confirmed' || status == 'completed' || status == 'cancelled' || status == 'dropped' || status == 'picked_up') ...[
                        const SizedBox(height: 12),
                        Container(
                          padding: const EdgeInsets.all(16),
                          decoration: BoxDecoration(
                            color: Colors.white,
                            borderRadius: BorderRadius.circular(18),
                            boxShadow: JT.cardShadow,
                          ),
                          child: Column(
                            crossAxisAlignment: CrossAxisAlignment.start,
                            children: [
                              Text('Pool Actions', style: JT.h5),
                              const SizedBox(height: 12),
                              Wrap(
                                spacing: 10,
                                runSpacing: 10,
                                children: [
                                  _actionChip(
                                    icon: Icons.chat_bubble_outline_rounded,
                                    label: 'Chat Driver',
                                    onTap: _openPoolChat,
                                  ),
                                  if (status == 'confirmed' || status == 'picked_up')
                                    _actionChip(
                                      icon: Icons.call_rounded,
                                      label: 'Call Driver',
                                      onTap: () => _startPoolCall(driverName, driverId),
                                    ),
                                  _actionChip(
                                    icon: Icons.people_alt_rounded,
                                    label: 'Co-Passengers',
                                    onTap: () => Navigator.of(context).push(
                                      MaterialPageRoute(
                                        builder: (_) => CoPassengerScreen(
                                          title: 'Co-Passengers',
                                          referenceId: widget.bookingId,
                                          isOutstation: true,
                                        ),
                                      ),
                                    ),
                                  ),
                                  _actionChip(
                                    icon: Icons.report_gmailerrorred_rounded,
                                    label: 'Report Issue',
                                    onTap: () => Navigator.of(context).push(
                                      MaterialPageRoute(
                                        builder: (_) => ReportIssueScreen(
                                          referenceId: widget.bookingId,
                                          module: 'outstation_pool',
                                          referenceType: 'booking',
                                          title: 'Report Pool Issue',
                                        ),
                                      ),
                                    ),
                                  ),
                                  _actionChip(
                                    icon: Icons.support_agent_rounded,
                                    label: 'Support',
                                    onTap: () => Navigator.of(context).push(
                                      MaterialPageRoute(
                                        builder: (_) => PoolSupportScreen(
                                          module: 'outstation_pool',
                                          referenceId: widget.bookingId,
                                          title: 'Pool Support',
                                        ),
                                      ),
                                    ),
                                  ),
                                  _actionChip(
                                    icon: Icons.shield_outlined,
                                    label: 'Safety',
                                    onTap: () => Navigator.of(context).push(
                                      MaterialPageRoute(
                                        builder: (_) => PoolSafetyScreen(
                                          title: 'Pool Safety',
                                          module: 'outstation_pool',
                                          referenceId: widget.bookingId,
                                          tripId: widget.bookingId,
                                          driverName: booking?['driverName']?.toString() ?? booking?['driver_name']?.toString() ?? '',
                                          vehicleInfo: '${booking?['vehicleModel'] ?? booking?['vehicle_model'] ?? ''} ${booking?['vehicleNumber'] ?? booking?['vehicle_number'] ?? ''}'.trim(),
                                          liveStatus: status,
                                          blockedUserId: booking?['driverId']?.toString() ?? booking?['driver_id']?.toString(),
                                        ),
                                      ),
                                    ),
                                  ),
                                  _actionChip(
                                    icon: Icons.timeline_rounded,
                                    label: 'Dispute',
                                    onTap: () => Navigator.of(context).push(
                                      MaterialPageRoute(
                                        builder: (_) => PoolDisputeTimelineScreen(
                                          title: 'Dispute Timeline',
                                          module: 'outstation_pool',
                                          referenceId: widget.bookingId,
                                        ),
                                      ),
                                    ),
                                  ),
                                  if (status == 'confirmed')
                                    _actionChip(
                                      icon: Icons.cancel_rounded,
                                      label: 'Cancel Booking',
                                      onTap: _openCancellationFlow,
                                    ),
                                  if (status == 'completed' || status == 'dropped')
                                    _actionChip(
                                      icon: Icons.star_rounded,
                                      label: 'Rate Driver',
                                      onTap: () => Navigator.of(context).push(
                                        MaterialPageRoute(
                                          builder: (_) => PoolRatingScreen(
                                            title: 'Rate Pool Driver',
                                            referenceId: widget.bookingId,
                                            isOutstation: true,
                                          ),
                                        ),
                                      ),
                                    ),
                                ],
                              ),
                            ],
                          ),
                        ),
                      ],
                      const SizedBox(height: 12),
                      Container(
                        padding: const EdgeInsets.all(16),
                        decoration: BoxDecoration(
                          color: Colors.white,
                          borderRadius: BorderRadius.circular(18),
                          boxShadow: JT.cardShadow,
                        ),
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            Text('Payment & Refund Timeline', style: JT.h5),
                            const SizedBox(height: 10),
                            _timelineRow(
                              'Booking confirmed',
                              'Seat locked under ${status.toUpperCase()} status.',
                              _statusColor(status),
                            ),
                            _timelineRow(
                              paymentStatus == 'paid' ? 'Payment settled' : 'Payment pending',
                              _paymentHint(paymentMethod.toLowerCase(), paymentStatus.toLowerCase()),
                              paymentStatus == 'paid' ? JT.success : JT.warning,
                            ),
                            _timelineRow(
                              'Support / refund follow-up',
                              status == 'cancelled'
                                  ? 'Cancellation-related refund checks go through Jago support.'
                                  : 'Use support if pickup, seat, or payment status looks incorrect.',
                              status == 'cancelled' ? JT.error : JT.primary,
                            ),
                          ],
                        ),
                      ),
                      const SizedBox(height: 12),
                      Container(
                        padding: const EdgeInsets.all(16),
                        decoration: BoxDecoration(
                          color: Colors.white,
                          borderRadius: BorderRadius.circular(18),
                          boxShadow: JT.cardShadow,
                        ),
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            Text('Need Help?', style: JT.h5),
                            const SizedBox(height: 6),
                            Text(
                              'For seat issues, pickup confusion, cancellation, refund, or driver concerns, reach Jago support from here.',
                              style: JT.body,
                            ),
                            const SizedBox(height: 14),
                            JT.gradientButton(
                              label: 'Open Support Chat',
                              onTap: () => Navigator.push(
                                context,
                                MaterialPageRoute(builder: (_) => const SupportChatScreen()),
                              ),
                            ),
                          ],
                        ),
                      ),
                    ],
                  ),
                ),
    );
  }

  Widget _timelineRow(String title, String subtitle, Color color) {
    return Padding(
      padding: const EdgeInsets.only(bottom: 12),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Container(
            width: 12,
            height: 12,
            margin: const EdgeInsets.only(top: 4),
            decoration: BoxDecoration(color: color, shape: BoxShape.circle),
          ),
          const SizedBox(width: 10),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(title, style: JT.subtitle1),
                const SizedBox(height: 2),
                Text(subtitle, style: JT.smallText),
              ],
            ),
          ),
        ],
      ),
    );
  }

  Widget _safetyNotice(String label) {
    final color = label == 'Blocked User'
        ? JT.error
        : label == 'High Risk User'
            ? JT.warning
            : JT.primary;
    return Container(
      padding: const EdgeInsets.all(14),
      decoration: BoxDecoration(
        color: color.withValues(alpha: 0.08),
        borderRadius: BorderRadius.circular(14),
        border: Border.all(color: color.withValues(alpha: 0.18)),
      ),
      child: Row(
        children: [
          Icon(Icons.shield_outlined, color: color, size: 18),
          const SizedBox(width: 10),
          Expanded(
            child: Text(
              '$label visibility is enabled for your safety. Use Safety or Support if you need help.',
              style: JT.smallText.copyWith(color: color),
            ),
          ),
        ],
      ),
    );
  }
}
