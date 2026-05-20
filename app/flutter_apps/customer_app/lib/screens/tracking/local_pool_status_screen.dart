import 'dart:async';
import 'dart:convert';
import 'package:flutter/material.dart';
import 'package:google_fonts/google_fonts.dart';
import 'package:http/http.dart' as http;
import '../../config/api_config.dart';
import '../../config/jago_theme.dart';
import '../../services/auth_service.dart';
import '../../services/socket_service.dart';

class LocalPoolStatusScreen extends StatefulWidget {
  final String requestId;
  final String pickupAddress;
  final String dropAddress;

  const LocalPoolStatusScreen({
    super.key,
    required this.requestId,
    required this.pickupAddress,
    required this.dropAddress,
  });

  @override
  State<LocalPoolStatusScreen> createState() => _LocalPoolStatusScreenState();
}

class _LocalPoolStatusScreenState extends State<LocalPoolStatusScreen> {
  final SocketService _socket = SocketService();
  Timer? _poller;
  StreamSubscription<Map<String, dynamic>>? _poolStatusSub;
  StreamSubscription<Map<String, dynamic>>? _seatSub;

  bool _loading = true;
  bool _cancelling = false;
  String? _error;
  Map<String, dynamic>? _booking;
  Map<String, dynamic>? _seatState;
  String _status = 'searching';

  @override
  void initState() {
    super.initState();
    _wireSocket();
    _load();
    _poller = Timer.periodic(const Duration(seconds: 8), (_) => _load(silent: true));
  }

  @override
  void dispose() {
    _poller?.cancel();
    _poolStatusSub?.cancel();
    _seatSub?.cancel();
    super.dispose();
  }

  void _wireSocket() {
    _poolStatusSub = _socket.onPoolStatus.listen((event) {
      final eventRequestId = event['requestId']?.toString() ?? '';
      if (eventRequestId.isNotEmpty && eventRequestId != widget.requestId) return;
      if (!mounted) return;
      setState(() {
        _status = event['status']?.toString() ?? _status;
        if (_booking != null) {
          if (_status == 'matched') {
            _booking = {
              ..._booking!,
              'status': 'matched',
              if (event['driver'] != null) 'driver': event['driver'],
            };
          } else if (_status == 'picked_up') {
            _booking = {..._booking!, 'status': 'picked_up'};
          } else if (_status == 'dropped') {
            _booking = {..._booking!, 'status': 'dropped'};
          } else if (_status == 'cancelled' || _status == 'search_timeout') {
            _booking = {..._booking!, 'status': 'cancelled'};
            _error = event['reason']?.toString() ?? event['message']?.toString();
          }
        }
      });
    });

    _seatSub = _socket.onPoolSeatUpdate.listen((event) {
      if (!mounted) return;
      setState(() => _seatState = event);
    });
  }

  Future<void> _load({bool silent = false}) async {
    if (!silent) {
      setState(() {
        _loading = true;
        _error = null;
      });
    }
    try {
      final headers = await AuthService.getHeaders();
      final res = await http.get(
        Uri.parse(ApiConfig.localPoolStatus(widget.requestId)),
        headers: headers,
      ).timeout(const Duration(seconds: 12));

      final body = jsonDecode(res.body);
      if (res.statusCode == 200) {
        final data = (body['data'] is Map<String, dynamic>) ? body['data'] as Map<String, dynamic> : body;
        final booking = (data['booking'] is Map<String, dynamic>) ? data['booking'] as Map<String, dynamic> : <String, dynamic>{};
        if (!mounted) return;
        setState(() {
          _booking = booking;
          _status = booking['status']?.toString() ?? _status;
          _loading = false;
          _error = null;
        });
      } else {
        if (!mounted) return;
        setState(() {
          _loading = false;
          _error = body['message']?.toString() ?? 'Could not load pool ride';
        });
      }
    } catch (_) {
      if (!mounted) return;
      setState(() {
        _loading = false;
        _error = 'Network issue while loading your pool ride.';
      });
    }
  }

  Future<void> _cancel() async {
    setState(() => _cancelling = true);
    try {
      final headers = await AuthService.getHeaders();
      final res = await http.post(
        Uri.parse(ApiConfig.localPoolCancel(widget.requestId)),
        headers: headers,
      ).timeout(const Duration(seconds: 12));
      final body = jsonDecode(res.body);
      if (res.statusCode == 200) {
        if (!mounted) return;
        setState(() {
          _status = 'cancelled';
          _booking = {...?_booking, 'status': 'cancelled'};
        });
        ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(content: Text('Pool booking cancelled')),
        );
      } else {
        if (!mounted) return;
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text(body['message']?.toString() ?? 'Cancel failed')),
        );
      }
    } catch (_) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('Network issue while cancelling')),
      );
    } finally {
      if (mounted) setState(() => _cancelling = false);
    }
  }

  String get _statusTitle {
    switch (_status) {
      case 'matched':
        return 'Driver matched';
      case 'picked_up':
        return 'On the way';
      case 'dropped':
        return 'Ride completed';
      case 'cancelled':
        return 'Booking closed';
      case 'search_timeout':
        return 'No pool driver found';
      default:
        return 'Searching nearby pooled driver';
    }
  }

  String get _statusSubtitle {
    switch (_status) {
      case 'matched':
        return 'Your pooled ride is confirmed. Reach pickup point and share OTP only after driver arrives.';
      case 'picked_up':
        return 'You are onboard. Live seat state and pooled occupancy are syncing.';
      case 'dropped':
        return 'This pooled ride is completed.';
      case 'cancelled':
        return _error ?? 'This pooled ride is cancelled.';
      case 'search_timeout':
        return 'No compatible pooled driver was found in time. Try regular ride or retry pool.';
      default:
        return 'We are clustering your route with active local pool drivers.';
    }
  }

  @override
  Widget build(BuildContext context) {
    final driver = _booking?['driver'] is Map<String, dynamic>
        ? _booking!['driver'] as Map<String, dynamic>
        : null;
    final fare = double.tryParse('${_booking?['total_fare'] ?? _booking?['totalFare'] ?? 0}') ?? 0;
    final seats = int.tryParse('${_booking?['seats_requested'] ?? _booking?['seatsRequested'] ?? 1}') ?? 1;
    final otp = _booking?['boarding_otp']?.toString() ?? _booking?['boardingOtp']?.toString() ?? '----';

    return Scaffold(
      backgroundColor: const Color(0xFFF7FAFF),
      appBar: AppBar(
        backgroundColor: Colors.white,
        elevation: 0,
        surfaceTintColor: Colors.transparent,
        leading: IconButton(
          icon: const Icon(Icons.arrow_back_ios_new_rounded, color: JT.textPrimary),
          onPressed: () => Navigator.pop(context),
        ),
        title: Text(
          'Local Pool Ride',
          style: GoogleFonts.poppins(fontWeight: FontWeight.w600, color: JT.textPrimary, fontSize: 17),
        ),
      ),
      body: _loading
          ? const Center(child: CircularProgressIndicator(color: JT.primary))
          : RefreshIndicator(
              onRefresh: _load,
              color: JT.primary,
              child: ListView(
                padding: const EdgeInsets.fromLTRB(16, 16, 16, 24),
                children: [
                  _headerCard(),
                  const SizedBox(height: 14),
                  _routeCard(),
                  const SizedBox(height: 14),
                  _seatCard(seats, fare),
                  const SizedBox(height: 14),
                  _otpCard(otp),
                  if (driver != null) ...[
                    const SizedBox(height: 14),
                    _driverCard(driver),
                  ],
                  if (_error != null && _status != 'cancelled' && _status != 'search_timeout') ...[
                    const SizedBox(height: 14),
                    _errorCard(),
                  ],
                  const SizedBox(height: 18),
                  if (_status == 'searching' || _status == 'matched')
                    SizedBox(
                      height: 52,
                      child: ElevatedButton(
                        onPressed: _cancelling ? null : _cancel,
                        style: ElevatedButton.styleFrom(
                          backgroundColor: Colors.white,
                          foregroundColor: Colors.red.shade600,
                          elevation: 0,
                          side: BorderSide(color: Colors.red.shade200),
                          shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(16)),
                        ),
                        child: Text(
                          _cancelling ? 'Cancelling...' : 'Cancel Pool Booking',
                          style: GoogleFonts.poppins(fontWeight: FontWeight.w600),
                        ),
                      ),
                    ),
                ],
              ),
            ),
    );
  }

  Widget _headerCard() {
    return Container(
      padding: const EdgeInsets.all(18),
      decoration: BoxDecoration(
        gradient: const LinearGradient(
          colors: [Color(0xFF2D8CFF), Color(0xFF1E6BE6)],
          begin: Alignment.topLeft,
          end: Alignment.bottomRight,
        ),
        borderRadius: BorderRadius.circular(22),
        boxShadow: [BoxShadow(color: JT.primary.withValues(alpha: 0.24), blurRadius: 20, offset: const Offset(0, 8))],
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(_statusTitle, style: GoogleFonts.poppins(color: Colors.white, fontSize: 20, fontWeight: FontWeight.w600)),
          const SizedBox(height: 6),
          Text(_statusSubtitle, style: GoogleFonts.poppins(color: Colors.white.withValues(alpha: 0.92), fontSize: 13)),
        ],
      ),
    );
  }

  Widget _routeCard() {
    return _card(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          _locationRow(Icons.my_location_rounded, 'Pickup', widget.pickupAddress),
          const Padding(
            padding: EdgeInsets.only(left: 11, top: 2, bottom: 2),
            child: SizedBox(height: 18, child: VerticalDivider(width: 2, thickness: 2, color: Color(0xFFE2E8F0))),
          ),
          _locationRow(Icons.location_on_rounded, 'Drop', widget.dropAddress),
        ],
      ),
    );
  }

  Widget _seatCard(int seats, double fare) {
    return _card(
      child: Row(
        children: [
          Expanded(child: _metric('Booked Seats', '$seats')),
          Expanded(child: _metric('Total Fare', '₹${fare.toStringAsFixed(0)}')),
          Expanded(child: _metric('Live Seats', '${_seatState?['availableSeats'] ?? '-'}')),
        ],
      ),
    );
  }

  Widget _otpCard(String otp) {
    return _card(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text('Boarding OTP', style: GoogleFonts.poppins(fontSize: 13, color: JT.textSecondary, fontWeight: FontWeight.w500)),
          const SizedBox(height: 8),
          Text(otp, style: GoogleFonts.poppins(fontSize: 30, fontWeight: FontWeight.w700, color: JT.primary, letterSpacing: 8)),
          const SizedBox(height: 6),
          Text('Share this only when the driver reaches your pickup point.', style: GoogleFonts.poppins(fontSize: 12, color: JT.textSecondary)),
        ],
      ),
    );
  }

  Widget _driverCard(Map<String, dynamic> driver) {
    return _card(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text('Assigned Driver', style: GoogleFonts.poppins(fontWeight: FontWeight.w600, color: JT.textPrimary)),
          const SizedBox(height: 10),
          Row(
            children: [
              CircleAvatar(
                radius: 24,
                backgroundColor: JT.primary.withValues(alpha: 0.1),
                child: Text(
                  (driver['name']?.toString().isNotEmpty == true) ? driver['name'].toString()[0].toUpperCase() : 'D',
                  style: GoogleFonts.poppins(color: JT.primary, fontWeight: FontWeight.w700),
                ),
              ),
              const SizedBox(width: 12),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(driver['name']?.toString() ?? 'Driver', style: GoogleFonts.poppins(fontWeight: FontWeight.w600)),
                    const SizedBox(height: 2),
                    Text(
                      '${driver['vehicleModel'] ?? ''} · ${driver['vehicleNumber'] ?? ''}',
                      style: GoogleFonts.poppins(fontSize: 12, color: JT.textSecondary),
                    ),
                  ],
                ),
              ),
            ],
          ),
        ],
      ),
    );
  }

  Widget _errorCard() {
    return Container(
      padding: const EdgeInsets.all(14),
      decoration: BoxDecoration(
        color: const Color(0xFFFFF1F2),
        borderRadius: BorderRadius.circular(16),
        border: Border.all(color: const Color(0xFFFECDD3)),
      ),
      child: Text(_error!, style: GoogleFonts.poppins(color: const Color(0xFFB42318), fontSize: 12)),
    );
  }

  Widget _metric(String label, String value) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(label, style: GoogleFonts.poppins(fontSize: 12, color: JT.textSecondary)),
        const SizedBox(height: 6),
        Text(value, style: GoogleFonts.poppins(fontSize: 18, color: JT.textPrimary, fontWeight: FontWeight.w600)),
      ],
    );
  }

  Widget _locationRow(IconData icon, String label, String value) {
    return Row(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Container(
          width: 22,
          height: 22,
          decoration: BoxDecoration(
            color: JT.primary.withValues(alpha: 0.12),
            borderRadius: BorderRadius.circular(11),
          ),
          child: Icon(icon, color: JT.primary, size: 14),
        ),
        const SizedBox(width: 10),
        Expanded(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(label, style: GoogleFonts.poppins(fontSize: 12, color: JT.textSecondary)),
              const SizedBox(height: 2),
              Text(value, style: GoogleFonts.poppins(fontSize: 13, color: JT.textPrimary, fontWeight: FontWeight.w500)),
            ],
          ),
        ),
      ],
    );
  }

  Widget _card({required Widget child}) {
    return Container(
      padding: const EdgeInsets.all(16),
      decoration: BoxDecoration(
        color: Colors.white,
        borderRadius: BorderRadius.circular(20),
        border: Border.all(color: const Color(0xFFE2E8F0)),
        boxShadow: [BoxShadow(color: Colors.black.withValues(alpha: 0.04), blurRadius: 10, offset: const Offset(0, 4))],
      ),
      child: child,
    );
  }
}
