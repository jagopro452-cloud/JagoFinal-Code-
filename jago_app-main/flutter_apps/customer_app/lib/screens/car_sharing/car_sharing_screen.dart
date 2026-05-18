import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:google_fonts/google_fonts.dart';
import 'package:http/http.dart' as http;

import '../../config/api_config.dart';
import '../../config/jago_theme.dart';
import '../../services/auth_service.dart';

class CarSharingScreen extends StatefulWidget {
  const CarSharingScreen({super.key});

  @override
  State<CarSharingScreen> createState() => _CarSharingScreenState();
}

class _CarSharingScreenState extends State<CarSharingScreen>
    with SingleTickerProviderStateMixin {
  static const _bg = Color(0xFFF8FAFC);
  static const _blue = JT.primary;
  static const _green = Color(0xFF10B981);
  static const _amber = Color(0xFFD97706);
  static const _poolAccent = Color(0xFF2563EB);

  late TabController _tabs;
  bool _loading = true;
  bool _myLoading = true;
  List _rides = [];
  List _myBookings = [];

  @override
  void initState() {
    super.initState();
    _tabs = TabController(length: 2, vsync: this);
    _loadRides();
    _loadMyBookings();
  }

  @override
  void dispose() {
    _tabs.dispose();
    super.dispose();
  }

  Future<void> _loadRides() async {
    if (mounted) setState(() => _loading = true);
    try {
      final headers = await AuthService.getHeaders();
      final res = await http.get(
        Uri.parse('${ApiConfig.baseUrl}/api/app/customer/car-sharing/rides'),
        headers: headers,
      );
      if (res.statusCode == 200 && mounted) {
        setState(() => _rides = jsonDecode(res.body)['data'] ?? []);
      }
    } catch (_) {}
    if (mounted) setState(() => _loading = false);
  }

  Future<void> _loadMyBookings() async {
    if (mounted) setState(() => _myLoading = true);
    try {
      final headers = await AuthService.getHeaders();
      final res = await http.get(
        Uri.parse('${ApiConfig.baseUrl}/api/app/customer/car-sharing/my-bookings'),
        headers: headers,
      );
      if (res.statusCode == 200 && mounted) {
        setState(() => _myBookings = jsonDecode(res.body)['data'] ?? []);
      }
    } catch (_) {}
    if (mounted) setState(() => _myLoading = false);
  }

  Future<void> _book(
    String rideId,
    String from,
    String to,
    double seatPrice,
    int availableSeats,
  ) async {
    final maxSelectableSeats = availableSeats.clamp(1, 2);
    var selectedSeats = 1;
    final res = await showDialog<bool>(
      context: context,
      builder: (ctx) => StatefulBuilder(
        builder: (ctx, setDialogState) {
          final totalFare = seatPrice * selectedSeats;
          return AlertDialog(
            shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(24)),
            titlePadding: const EdgeInsets.fromLTRB(22, 22, 22, 0),
            contentPadding: const EdgeInsets.fromLTRB(22, 14, 22, 4),
            actionsPadding: const EdgeInsets.fromLTRB(16, 8, 16, 16),
            title: Text(
              'Confirm Car Pool',
              style: GoogleFonts.poppins(fontWeight: FontWeight.w700),
            ),
            content: Column(
              mainAxisSize: MainAxisSize.min,
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  '$from -> $to',
                  style: GoogleFonts.poppins(
                    fontWeight: FontWeight.w600,
                    color: JT.textPrimary,
                  ),
                ),
                const SizedBox(height: 12),
                Container(
                  padding: const EdgeInsets.all(14),
                  decoration: BoxDecoration(
                    gradient: LinearGradient(
                      colors: [
                        _poolAccent.withValues(alpha: 0.10),
                        _green.withValues(alpha: 0.08),
                      ],
                    ),
                    borderRadius: BorderRadius.circular(18),
                    border: Border.all(color: _poolAccent.withValues(alpha: 0.14)),
                  ),
                  child: Row(
                    children: [
                      _vehicleArt('shared cab', size: 54),
                      const SizedBox(width: 12),
                      Expanded(
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            Text(
                              'Rs ${seatPrice.toStringAsFixed(0)} per seat',
                              style: GoogleFonts.poppins(
                                color: _green,
                                fontSize: 15,
                                fontWeight: FontWeight.w700,
                              ),
                            ),
                            const SizedBox(height: 3),
                            Text(
                              'You can book up to 2 seats per trip',
                              style: GoogleFonts.poppins(
                                color: Colors.grey.shade600,
                                fontSize: 11.5,
                              ),
                            ),
                          ],
                        ),
                      ),
                    ],
                  ),
                ),
                const SizedBox(height: 14),
                Text(
                  'Select seats',
                  style: GoogleFonts.poppins(
                    fontSize: 12.5,
                    fontWeight: FontWeight.w600,
                    color: JT.textPrimary,
                  ),
                ),
                const SizedBox(height: 8),
                Row(
                  children: [1, 2].map((seatCount) {
                    final enabled = seatCount <= maxSelectableSeats;
                    final active = selectedSeats == seatCount;
                    return Expanded(
                      child: Padding(
                        padding: EdgeInsets.only(right: seatCount == 1 ? 8 : 0),
                        child: InkWell(
                          borderRadius: BorderRadius.circular(14),
                          onTap: enabled
                              ? () => setDialogState(() => selectedSeats = seatCount)
                              : null,
                          child: AnimatedContainer(
                            duration: const Duration(milliseconds: 180),
                            padding: const EdgeInsets.symmetric(vertical: 12),
                            decoration: BoxDecoration(
                              color: active ? _blue : Colors.white,
                              borderRadius: BorderRadius.circular(14),
                              border: Border.all(
                                color: active
                                    ? _blue
                                    : enabled
                                        ? const Color(0xFFDCE9FF)
                                        : Colors.grey.shade300,
                              ),
                              boxShadow: active
                                  ? [
                                      BoxShadow(
                                        color: _blue.withValues(alpha: 0.22),
                                        blurRadius: 12,
                                        offset: const Offset(0, 5),
                                      ),
                                    ]
                                  : null,
                            ),
                            child: Column(
                              children: [
                                Icon(
                                  Icons.event_seat_rounded,
                                  color: active
                                      ? Colors.white
                                      : enabled
                                          ? _blue
                                          : Colors.grey.shade400,
                                  size: 19,
                                ),
                                const SizedBox(height: 4),
                                Text(
                                  '$seatCount seat${seatCount == 1 ? '' : 's'}',
                                  style: GoogleFonts.poppins(
                                    color: active
                                        ? Colors.white
                                        : enabled
                                            ? JT.textPrimary
                                            : Colors.grey.shade400,
                                    fontWeight: FontWeight.w700,
                                    fontSize: 12,
                                  ),
                                ),
                              ],
                            ),
                          ),
                        ),
                      ),
                    );
                  }).toList(),
                ),
                const SizedBox(height: 14),
                Row(
                  children: [
                    Text(
                      'Total',
                      style: GoogleFonts.poppins(
                        color: Colors.grey.shade600,
                        fontWeight: FontWeight.w500,
                      ),
                    ),
                    const Spacer(),
                    Text(
                      'Rs ${totalFare.toStringAsFixed(0)}',
                      style: GoogleFonts.poppins(
                        color: _green,
                        fontSize: 20,
                        fontWeight: FontWeight.w800,
                      ),
                    ),
                  ],
                ),
              ],
            ),
            actions: [
              TextButton(
                onPressed: () => Navigator.pop(ctx, false),
                child: Text('Cancel', style: GoogleFonts.poppins()),
              ),
              ElevatedButton(
                onPressed: () => Navigator.pop(ctx, true),
                style: ElevatedButton.styleFrom(
                  backgroundColor: _green,
                  shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(14)),
                ),
                child: Text(
                  'Book $selectedSeats',
                  style: GoogleFonts.poppins(
                    color: Colors.white,
                    fontWeight: FontWeight.w700,
                  ),
                ),
              ),
            ],
          );
        },
      ),
    );
    if (res != true) return;

    try {
      final headers = await AuthService.getHeaders();
      final bookRes = await http.post(
        Uri.parse('${ApiConfig.baseUrl}/api/app/customer/car-sharing/book'),
        headers: {...headers, 'Content-Type': 'application/json'},
        body: jsonEncode({'rideId': rideId, 'seatsBooked': selectedSeats}),
      );
      final d = jsonDecode(bookRes.body);
      if (!mounted) return;
      if (bookRes.statusCode == 200) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(
            content: Text(d['message'] ?? 'Booking confirmed!'),
            backgroundColor: Colors.green,
          ),
        );
        _loadRides();
        _loadMyBookings();
        _tabs.animateTo(1);
      } else {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(
            content: Text(d['message'] ?? 'Booking failed'),
            backgroundColor: Colors.red,
          ),
        );
      }
    } catch (e) {
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text('Error: $e'), backgroundColor: Colors.red),
      );
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: _bg,
      appBar: AppBar(
        backgroundColor: Colors.white,
        foregroundColor: _blue,
        elevation: 0.5,
        title: Text(
          'Car Sharing',
          style: GoogleFonts.poppins(
            fontWeight: FontWeight.w600,
            fontSize: 18,
          ),
        ),
        centerTitle: true,
        bottom: TabBar(
          controller: _tabs,
          labelColor: _blue,
          unselectedLabelColor: Colors.grey,
          indicatorColor: _blue,
          labelStyle: GoogleFonts.poppins(
            fontSize: 13,
            fontWeight: FontWeight.w600,
          ),
          unselectedLabelStyle: GoogleFonts.poppins(
            fontSize: 13,
            fontWeight: FontWeight.w400,
          ),
          tabs: const [
            Tab(text: 'Available Rides'),
            Tab(text: 'My Bookings'),
          ],
        ),
      ),
      body: TabBarView(
        controller: _tabs,
        children: [
          _buildRidesList(),
          _buildMyBookings(),
        ],
      ),
    );
  }

  Widget _buildRidesList() {
    if (_loading) {
      return const Center(child: CircularProgressIndicator(color: JT.primary));
    }
    if (_rides.isEmpty) {
      return _empty(
        'No shared rides available',
        'Shared rides will appear here once pilots open seats on their route.',
      );
    }
    return RefreshIndicator(
      onRefresh: _loadRides,
      child: ListView.builder(
        padding: const EdgeInsets.all(12),
        itemCount: _rides.length,
        itemBuilder: (_, i) => _rideCard(_rides[i]),
      ),
    );
  }

  Widget _buildMyBookings() {
    if (_myLoading) {
      return const Center(child: CircularProgressIndicator(color: JT.primary));
    }
    if (_myBookings.isEmpty) {
      return _empty(
        'No bookings yet',
        'Book a shared ride seat and your confirmed trips will show here.',
      );
    }
    return RefreshIndicator(
      onRefresh: _loadMyBookings,
      child: ListView.builder(
        padding: const EdgeInsets.all(12),
        itemCount: _myBookings.length,
        itemBuilder: (_, i) => _bookingCard(_myBookings[i]),
      ),
    );
  }

  Widget _rideCard(Map d) {
    final from = d['fromLocation'] ?? 'From';
    final to = d['toLocation'] ?? 'To';
    final driver = d['driverName'] ?? 'Driver';
    final vehicle = d['vehicleName'] ?? 'Shared cab';
    final available = int.tryParse('${d['availableSeats'] ?? 0}') ?? 0;
    final seatPrice = (d['seatPrice'] ?? 0).toDouble();
    final depTime = d['departureTime'] != null ? _fmt(d['departureTime']) : '--';

    return Container(
      margin: const EdgeInsets.only(bottom: 12),
      decoration: BoxDecoration(
        color: Colors.white,
        borderRadius: BorderRadius.circular(18),
        border: Border.all(color: const Color(0xFFDCE9FF)),
        boxShadow: [
          BoxShadow(
            color: Colors.black.withValues(alpha: 0.06),
            blurRadius: 12,
            offset: const Offset(0, 3),
          ),
        ],
      ),
      child: ClipRRect(
        borderRadius: BorderRadius.circular(18),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Container(
              padding: const EdgeInsets.fromLTRB(16, 14, 16, 0),
              decoration: BoxDecoration(
                gradient: LinearGradient(
                  colors: [Colors.white, _poolAccent.withValues(alpha: 0.06)],
                  begin: Alignment.topLeft,
                  end: Alignment.bottomRight,
                ),
              ),
              child: Row(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Container(
                          padding: const EdgeInsets.symmetric(
                            horizontal: 10,
                            vertical: 5,
                          ),
                          decoration: BoxDecoration(
                            color: _poolAccent.withValues(alpha: 0.10),
                            borderRadius: BorderRadius.circular(999),
                          ),
                          child: Text(
                            'SHARED RIDE',
                            style: GoogleFonts.poppins(
                              fontSize: 10,
                              fontWeight: FontWeight.w700,
                              color: _poolAccent,
                              letterSpacing: 0.4,
                            ),
                          ),
                        ),
                        const SizedBox(height: 12),
                        Text(
                          '$from -> $to',
                          style: GoogleFonts.poppins(
                            fontWeight: FontWeight.w600,
                            fontSize: 15,
                            color: JT.textPrimary,
                            height: 1.2,
                          ),
                          maxLines: 2,
                          overflow: TextOverflow.ellipsis,
                        ),
                        const SizedBox(height: 8),
                        Container(
                          padding: const EdgeInsets.symmetric(
                            horizontal: 10,
                            vertical: 4,
                          ),
                          decoration: BoxDecoration(
                            color: _green.withValues(alpha: 0.10),
                            borderRadius: BorderRadius.circular(20),
                          ),
                          child: Text(
                            'Rs ${seatPrice.toStringAsFixed(0)}/seat',
                            style: GoogleFonts.poppins(
                              color: _green,
                              fontWeight: FontWeight.w600,
                              fontSize: 12,
                            ),
                          ),
                        ),
                      ],
                    ),
                  ),
                  const SizedBox(width: 10),
                  _vehicleArt(vehicle),
                ],
              ),
            ),
            Padding(
              padding: const EdgeInsets.fromLTRB(16, 14, 16, 16),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Row(
                    children: [
                      const Icon(
                        Icons.person_rounded,
                        size: 14,
                        color: Colors.grey,
                      ),
                      const SizedBox(width: 4),
                      Expanded(
                        child: Text(
                          driver,
                          style: GoogleFonts.poppins(
                            color: Colors.grey.shade700,
                            fontSize: 12,
                            fontWeight: FontWeight.w500,
                          ),
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                        ),
                      ),
                      Container(
                        padding: const EdgeInsets.symmetric(
                          horizontal: 8,
                          vertical: 3,
                        ),
                        decoration: BoxDecoration(
                          color: available > 0
                              ? _blue.withValues(alpha: 0.08)
                              : Colors.red.withValues(alpha: 0.08),
                          borderRadius: BorderRadius.circular(8),
                        ),
                        child: Text(
                          '$available seats left',
                          style: GoogleFonts.poppins(
                            color: available > 0 ? _blue : Colors.red,
                            fontSize: 11,
                            fontWeight: FontWeight.w600,
                          ),
                        ),
                      ),
                    ],
                  ),
                  const SizedBox(height: 8),
                  Row(
                    children: [
                      const Icon(
                        Icons.directions_car_rounded,
                        size: 14,
                        color: Colors.grey,
                      ),
                      const SizedBox(width: 4),
                      Expanded(
                        child: Text(
                          vehicle,
                          style: GoogleFonts.poppins(
                            color: Colors.grey.shade700,
                            fontSize: 12,
                          ),
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                        ),
                      ),
                      const Icon(
                        Icons.access_time_rounded,
                        size: 14,
                        color: Colors.grey,
                      ),
                      const SizedBox(width: 4),
                      Text(
                        depTime,
                        style: GoogleFonts.poppins(
                          color: Colors.grey.shade700,
                          fontSize: 12,
                        ),
                      ),
                    ],
                  ),
                  if (available > 0) ...[
                    const SizedBox(height: 14),
                    SizedBox(
                      width: double.infinity,
                      height: 42,
                      child: ElevatedButton(
                        onPressed: () =>
                            _book(d['id'], from, to, seatPrice, available),
                        style: ElevatedButton.styleFrom(
                          backgroundColor: _blue,
                          foregroundColor: Colors.white,
                          shape: RoundedRectangleBorder(
                            borderRadius: BorderRadius.circular(12),
                          ),
                          elevation: 0,
                        ),
                        child: Text(
                          'Book a Seat',
                          style: GoogleFonts.poppins(
                            fontWeight: FontWeight.w600,
                            fontSize: 13,
                          ),
                        ),
                      ),
                    ),
                  ],
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }

  Widget _bookingCard(Map d) {
    final from = d['fromLocation'] ?? 'From';
    final to = d['toLocation'] ?? 'To';
    final driver = d['driverName'] ?? 'Driver';
    final vehicle = d['vehicleName'] ?? 'Shared cab';
    final status = d['status'] ?? 'confirmed';
    final seats = d['seatsBooked'] ?? 1;
    final total = (d['totalFare'] ?? 0).toDouble();
    final depTime = d['departureTime'] != null ? _fmt(d['departureTime']) : '--';
    final Color statusColor =
        status == 'confirmed' ? _green : status == 'cancelled' ? Colors.red : _amber;

    return Container(
      margin: const EdgeInsets.only(bottom: 10),
      decoration: BoxDecoration(
        color: Colors.white,
        borderRadius: BorderRadius.circular(16),
        border: Border.all(color: const Color(0xFFDCE9FF)),
        boxShadow: [
          BoxShadow(
            color: Colors.black.withValues(alpha: 0.05),
            blurRadius: 8,
          ),
        ],
      ),
      child: Padding(
        padding: const EdgeInsets.all(14),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                _vehicleArt(vehicle, size: 62),
                const SizedBox(width: 12),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(
                        '$from -> $to',
                        style: GoogleFonts.poppins(
                          fontWeight: FontWeight.w600,
                          fontSize: 13,
                          color: JT.textPrimary,
                        ),
                        maxLines: 2,
                        overflow: TextOverflow.ellipsis,
                      ),
                      const SizedBox(height: 6),
                      Text(
                        'Driver: $driver',
                        style: GoogleFonts.poppins(
                          color: Colors.grey.shade700,
                          fontSize: 12,
                        ),
                      ),
                    ],
                  ),
                ),
                Container(
                  padding: const EdgeInsets.symmetric(
                    horizontal: 8,
                    vertical: 3,
                  ),
                  decoration: BoxDecoration(
                    color: statusColor.withValues(alpha: 0.1),
                    borderRadius: BorderRadius.circular(6),
                  ),
                  child: Text(
                    status.toUpperCase(),
                    style: GoogleFonts.poppins(
                      color: statusColor,
                      fontSize: 10,
                      fontWeight: FontWeight.w600,
                    ),
                  ),
                ),
              ],
            ),
            const SizedBox(height: 10),
            Row(
              children: [
                const Icon(
                  Icons.access_time_rounded,
                  size: 12,
                  color: Colors.grey,
                ),
                const SizedBox(width: 4),
                Text(
                  depTime,
                  style: GoogleFonts.poppins(
                    color: Colors.grey.shade700,
                    fontSize: 11,
                  ),
                ),
                const Spacer(),
                Text(
                  '$seats seat(s) | Rs ${total.toStringAsFixed(0)}',
                  style: GoogleFonts.poppins(
                    fontWeight: FontWeight.w600,
                    fontSize: 12,
                    color: _poolAccent,
                  ),
                ),
              ],
            ),
          ],
        ),
      ),
    );
  }

  Widget _vehicleArt(String vehicleName, {double size = 84}) {
    final imageUrl = _poolVehicleImage(vehicleName);
    return Container(
      width: size,
      height: size,
      decoration: BoxDecoration(
        borderRadius: BorderRadius.circular(16),
        gradient: LinearGradient(
          colors: [Colors.white, _poolAccent.withValues(alpha: 0.08)],
          begin: Alignment.topLeft,
          end: Alignment.bottomRight,
        ),
      ),
      child: Padding(
        padding: const EdgeInsets.all(8),
        child: Image.network(
          imageUrl,
          fit: BoxFit.contain,
          errorBuilder: (_, __, ___) => Icon(
            Icons.groups_rounded,
            size: size * 0.42,
            color: _poolAccent.withValues(alpha: 0.55),
          ),
        ),
      ),
    );
  }

  String _poolVehicleImage(String vehicleName) {
    final lower = vehicleName.toLowerCase();
    if (lower.contains('premium') || lower.contains('suv')) {
      return 'https://res.cloudinary.com/dg5ct7fys/image/upload/f_auto,q_auto/ChatGPT_Image_Apr_17_2026_11_31_05_AM_kavp5e';
    }
    return 'https://res.cloudinary.com/dg5ct7fys/image/upload/f_auto,q_auto/ChatGPT_Image_Apr_17_2026_11_27_28_AM_w0rcnh';
  }

  Widget _empty(String title, String sub) {
    return Center(
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: 28),
        child: Column(
          mainAxisAlignment: MainAxisAlignment.center,
          children: [
            _vehicleArt('shared cab', size: 104),
            const SizedBox(height: 18),
            Text(
              title,
              textAlign: TextAlign.center,
              style: GoogleFonts.poppins(
                fontWeight: FontWeight.w600,
                fontSize: 16,
                color: JT.textPrimary,
              ),
            ),
            const SizedBox(height: 6),
            Text(
              sub,
              textAlign: TextAlign.center,
              style: GoogleFonts.poppins(
                color: Colors.grey.shade600,
                fontSize: 13,
                height: 1.45,
              ),
            ),
          ],
        ),
      ),
    );
  }

  String _fmt(String iso) {
    try {
      final dt = DateTime.parse(iso).toLocal();
      final h = dt.hour;
      final m = dt.minute.toString().padLeft(2, '0');
      final ampm = h >= 12 ? 'PM' : 'AM';
      final hr = h % 12 == 0 ? 12 : h % 12;
      return '${dt.day}/${dt.month} $hr:$m $ampm';
    } catch (_) {
      return iso.substring(0, 16);
    }
  }
}
