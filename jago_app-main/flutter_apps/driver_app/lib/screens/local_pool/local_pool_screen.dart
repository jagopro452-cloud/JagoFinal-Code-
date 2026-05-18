import 'dart:async';
import 'dart:convert';
import 'package:flutter/material.dart';
import 'package:google_fonts/google_fonts.dart';
import 'package:http/http.dart' as http;
import '../../config/api_config.dart';
import '../../services/auth_service.dart';
import '../../services/socket_service.dart';

class LocalPoolScreen extends StatefulWidget {
  const LocalPoolScreen({super.key});

  @override
  State<LocalPoolScreen> createState() => _LocalPoolScreenState();
}

class _LocalPoolScreenState extends State<LocalPoolScreen> {
  final SocketService _socket = SocketService();
  final TextEditingController _otpCtrl = TextEditingController();
  Timer? _poller;
  StreamSubscription<Map<String, dynamic>>? _newPassengerSub;
  StreamSubscription<Map<String, dynamic>>? _seatSub;
  StreamSubscription<Map<String, dynamic>>? _cancelSub;

  bool _loading = true;
  bool _starting = false;
  bool _ending = false;
  bool _updatingAccepting = false;
  int _maxSeats = 4;
  Map<String, dynamic>? _session;
  List<dynamic> _passengers = [];
  Map<String, dynamic>? _seatState;
  String? _error;

  static const _primary = Color(0xFF2D8CFF);
  static const _bg = Color(0xFFFFFFFF);
  static const _surface = Color(0xFFF8FAFE);
  static const _border = Color(0xFFE5E9F0);
  static const _textPri = Color(0xFF111827);
  static const _textSec = Color(0xFF6B7280);

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
    _newPassengerSub?.cancel();
    _seatSub?.cancel();
    _cancelSub?.cancel();
    _otpCtrl.dispose();
    super.dispose();
  }

  void _wireSocket() {
    _newPassengerSub = _socket.onPoolNewPassenger.listen((_) => _load(silent: true));
    _seatSub = _socket.onPoolSeatUpdate.listen((event) {
      if (!mounted) return;
      setState(() => _seatState = event);
    });
    _cancelSub = _socket.onPoolPassengerCancelled.listen((_) => _load(silent: true));
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
        Uri.parse(ApiConfig.localPoolSessionActive),
        headers: headers,
      ).timeout(const Duration(seconds: 12));
      final body = jsonDecode(res.body);
      if (res.statusCode == 200) {
        final data = (body['data'] is Map<String, dynamic>) ? body['data'] as Map<String, dynamic> : body;
        if (!mounted) return;
        setState(() {
          _session = data['session'] as Map<String, dynamic>?;
          _passengers = List<dynamic>.from(data['passengers'] ?? const []);
          _loading = false;
          _error = null;
        });
      } else {
        if (!mounted) return;
        setState(() {
          _loading = false;
          _error = body['message']?.toString() ?? 'Failed to load local pool';
        });
      }
    } catch (_) {
      if (!mounted) return;
      setState(() {
        _loading = false;
        _error = 'Network issue while loading local pool';
      });
    }
  }

  Future<void> _startSession() async {
    setState(() => _starting = true);
    try {
      final headers = await AuthService.getHeaders();
      final res = await http.post(
        Uri.parse(ApiConfig.localPoolSessionStart),
        headers: headers,
        body: jsonEncode({'maxSeats': _maxSeats}),
      ).timeout(const Duration(seconds: 12));
      if (res.statusCode == 200) {
        await _load();
      } else {
        final body = jsonDecode(res.body);
        if (!mounted) return;
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text(body['message']?.toString() ?? 'Could not start local pool')),
        );
      }
    } catch (_) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('Network issue while starting local pool')),
      );
    } finally {
      if (mounted) setState(() => _starting = false);
    }
  }

  Future<void> _endSession() async {
    setState(() => _ending = true);
    try {
      final headers = await AuthService.getHeaders();
      final res = await http.post(
        Uri.parse(ApiConfig.localPoolSessionEnd),
        headers: headers,
      ).timeout(const Duration(seconds: 12));
      if (res.statusCode == 200) {
        await _load();
      }
    } finally {
      if (mounted) setState(() => _ending = false);
    }
  }

  bool get _acceptingNewPassengers {
    final seatEventValue = _seatState?['acceptingNewRequests'];
    if (seatEventValue is bool) return seatEventValue;
    final camel = _session?['acceptingNewRequests'];
    if (camel is bool) return camel;
    final snake = _session?['accepting_new_requests'];
    if (snake is bool) return snake;
    return true;
  }

  Future<void> _toggleAccepting(bool accepting) async {
    setState(() => _updatingAccepting = true);
    try {
      final headers = await AuthService.getHeaders();
      final res = await http.post(
        Uri.parse(ApiConfig.localPoolSessionAccepting),
        headers: headers,
        body: jsonEncode({'acceptingNewRequests': accepting}),
      ).timeout(const Duration(seconds: 12));
      final body = jsonDecode(res.body);
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text(body['message']?.toString() ?? (accepting ? 'Accepting new passengers' : 'New passengers paused'))),
      );
      if (res.statusCode == 200) {
        setState(() {
          _seatState = {
            ...?_seatState,
            'acceptingNewRequests': accepting,
          };
          _session = {
            ...?_session,
            'accepting_new_requests': accepting,
            'acceptingNewRequests': accepting,
          };
        });
      }
    } catch (_) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('Network issue while updating pool mode')),
      );
    } finally {
      if (mounted) setState(() => _updatingAccepting = false);
    }
  }

  Future<void> _pickupPassenger(String requestId) async {
    _otpCtrl.clear();
    final otp = await showDialog<String>(
      context: context,
      builder: (_) => AlertDialog(
        title: const Text('Enter Boarding OTP'),
        content: TextField(
          controller: _otpCtrl,
          keyboardType: TextInputType.number,
          maxLength: 4,
          decoration: const InputDecoration(hintText: '4-digit OTP'),
        ),
        actions: [
          TextButton(onPressed: () => Navigator.pop(context), child: const Text('Cancel')),
          ElevatedButton(onPressed: () => Navigator.pop(context, _otpCtrl.text.trim()), child: const Text('Verify')),
        ],
      ),
    );
    if (otp == null || otp.isEmpty) return;

    await _postSimple(ApiConfig.localPoolPickup(requestId), {'otp': otp});
  }

  Future<void> _dropPassenger(String requestId) async {
    await _postSimple(ApiConfig.localPoolDrop(requestId), const {});
  }

  Future<void> _markNoShow(String requestId) async {
    await _postSimple(ApiConfig.localPoolNoShow(requestId), const {});
  }

  Future<void> _postSimple(String url, Map<String, dynamic> body) async {
    try {
      final headers = await AuthService.getHeaders();
      final res = await http.post(
        Uri.parse(url),
        headers: headers,
        body: jsonEncode(body),
      ).timeout(const Duration(seconds: 12));
      final payload = jsonDecode(res.body);
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text(payload['message']?.toString() ?? (res.statusCode == 200 ? 'Updated' : 'Action failed'))),
      );
      if (res.statusCode == 200) {
        await _load();
      }
    } catch (_) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('Network issue. Please retry.')),
      );
    }
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
        title: Text('Local Pool', style: GoogleFonts.poppins(fontSize: 17, fontWeight: FontWeight.w600, color: _textPri)),
        actions: [
          IconButton(icon: const Icon(Icons.refresh_rounded, color: _primary), onPressed: _load),
          const SizedBox(width: 4),
        ],
      ),
      body: _loading
          ? const Center(child: CircularProgressIndicator(color: _primary, strokeWidth: 2.5))
          : _error != null
              ? _buildError()
              : RefreshIndicator(
                  onRefresh: _load,
                  color: _primary,
                  child: ListView(
                    padding: const EdgeInsets.fromLTRB(16, 12, 16, 32),
                    children: [
                      if (_session == null) _buildStarter() else ...[
                        _buildSessionHero(),
                        const SizedBox(height: 14),
                        _buildAcceptingControl(),
                        const SizedBox(height: 14),
                        _buildMetrics(),
                        const SizedBox(height: 14),
                        _buildPassengers(),
                      ],
                    ],
                  ),
                ),
    );
  }

  Widget _buildError() {
    return Center(
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          const Icon(Icons.cloud_off_rounded, size: 52, color: _textSec),
          const SizedBox(height: 12),
          Text(_error!, style: GoogleFonts.poppins(color: _textSec)),
        ],
      ),
    );
  }

  Widget _buildStarter() {
    return Container(
      padding: const EdgeInsets.all(20),
      decoration: BoxDecoration(
        color: Colors.white,
        borderRadius: BorderRadius.circular(20),
        border: Border.all(color: _border),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text('Start Local Pool Mode', style: GoogleFonts.poppins(fontWeight: FontWeight.w600, fontSize: 18, color: _textPri)),
          const SizedBox(height: 8),
          Text('Go live for shared city rides. Passengers will be clustered by direction and live seat availability.', style: GoogleFonts.poppins(fontSize: 13, color: _textSec)),
          const SizedBox(height: 18),
          Text('Seats', style: GoogleFonts.poppins(fontWeight: FontWeight.w500)),
          const SizedBox(height: 8),
          DropdownButtonFormField<int>(
            initialValue: _maxSeats,
            decoration: InputDecoration(
              filled: true,
              fillColor: _surface,
              border: OutlineInputBorder(borderRadius: BorderRadius.circular(14), borderSide: BorderSide.none),
            ),
            items: const [3, 4, 5, 6].map((e) => DropdownMenuItem(value: e, child: Text('$e seats'))).toList(),
            onChanged: (v) => setState(() => _maxSeats = v ?? 4),
          ),
          const SizedBox(height: 18),
          SizedBox(
            width: double.infinity,
            height: 52,
            child: ElevatedButton(
              onPressed: _starting ? null : _startSession,
              style: ElevatedButton.styleFrom(
                backgroundColor: _primary,
                shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(16)),
              ),
              child: Text(_starting ? 'Starting...' : 'Start Local Pool', style: GoogleFonts.poppins(color: Colors.white, fontWeight: FontWeight.w600)),
            ),
          ),
        ],
      ),
    );
  }

  Widget _buildSessionHero() {
    return Container(
      padding: const EdgeInsets.all(18),
      decoration: BoxDecoration(
        gradient: const LinearGradient(
          colors: [Color(0xFF2D8CFF), Color(0xFF1E6BE6)],
          begin: Alignment.topLeft,
          end: Alignment.bottomRight,
        ),
        borderRadius: BorderRadius.circular(20),
        boxShadow: [BoxShadow(color: _primary.withValues(alpha: 0.25), blurRadius: 18, offset: const Offset(0, 8))],
      ),
      child: Row(
        children: [
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text('Pool mode active', style: GoogleFonts.poppins(color: Colors.white, fontSize: 20, fontWeight: FontWeight.w600)),
                const SizedBox(height: 6),
                Text('Live seat sync, OTP boarding, and grouped passenger queue are active now.', style: GoogleFonts.poppins(color: Colors.white.withValues(alpha: 0.92), fontSize: 12.5)),
              ],
            ),
          ),
          TextButton(
            onPressed: _ending ? null : _endSession,
            style: TextButton.styleFrom(
              backgroundColor: Colors.white.withValues(alpha: 0.16),
              foregroundColor: Colors.white,
              shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12)),
            ),
            child: Text(_ending ? 'Ending...' : 'End', style: GoogleFonts.poppins(fontWeight: FontWeight.w600)),
          ),
        ],
      ),
    );
  }

  Widget _buildMetrics() {
    return Container(
      padding: const EdgeInsets.all(16),
      decoration: BoxDecoration(color: Colors.white, borderRadius: BorderRadius.circular(18), border: Border.all(color: _border)),
      child: Row(
        children: [
          Expanded(child: _metric('Available', '${_seatState?['availableSeats'] ?? _session?['available_seats'] ?? 0}')),
          Expanded(child: _metric('Occupied', '${_seatState?['occupiedSeats'] ?? 0}')),
          Expanded(child: _metric('Onboard', '${_seatState?['onboardPassengers'] ?? 0}')),
        ],
      ),
    );
  }

  Widget _buildAcceptingControl() {
    final accepting = _acceptingNewPassengers;
    return Container(
      padding: const EdgeInsets.all(16),
      decoration: BoxDecoration(color: Colors.white, borderRadius: BorderRadius.circular(18), border: Border.all(color: _border)),
      child: Row(
        children: [
          Container(
            width: 42,
            height: 42,
            decoration: BoxDecoration(
              color: (accepting ? const Color(0xFF16A34A) : const Color(0xFFF97316)).withValues(alpha: 0.10),
              borderRadius: BorderRadius.circular(14),
            ),
            child: Icon(
              accepting ? Icons.group_add_rounded : Icons.pause_circle_filled_rounded,
              color: accepting ? const Color(0xFF16A34A) : const Color(0xFFF97316),
            ),
          ),
          const SizedBox(width: 12),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(accepting ? 'Accepting new passengers' : 'New passengers paused', style: GoogleFonts.poppins(fontWeight: FontWeight.w600, color: _textPri)),
                const SizedBox(height: 2),
                Text(
                  accepting ? 'Matching is live while seats are available.' : 'Current passengers continue. No new pool requests will match.',
                  style: GoogleFonts.poppins(fontSize: 12, color: _textSec),
                ),
              ],
            ),
          ),
          Switch.adaptive(
            value: accepting,
            activeThumbColor: _primary,
            onChanged: _updatingAccepting ? null : _toggleAccepting,
          ),
        ],
      ),
    );
  }

  Widget _metric(String label, String value) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(label, style: GoogleFonts.poppins(fontSize: 12, color: _textSec)),
        const SizedBox(height: 4),
        Text(value, style: GoogleFonts.poppins(fontSize: 18, fontWeight: FontWeight.w600, color: _textPri)),
      ],
    );
  }

  Widget _buildPassengers() {
    if (_passengers.isEmpty) {
      return Container(
        padding: const EdgeInsets.all(26),
        decoration: BoxDecoration(color: Colors.white, borderRadius: BorderRadius.circular(18), border: Border.all(color: _border)),
        child: Column(
          children: [
            const Icon(Icons.people_outline_rounded, color: _textSec, size: 46),
            const SizedBox(height: 10),
            Text('Waiting for pooled passengers', style: GoogleFonts.poppins(fontSize: 14, color: _textSec)),
          ],
        ),
      );
    }
    return Column(
      children: _passengers.map((p) => _buildPassengerCard(p as Map<String, dynamic>)).toList(),
    );
  }

  Widget _buildPassengerCard(Map<String, dynamic> p) {
    final status = p['status']?.toString() ?? 'matched';
    final requestId = p['id']?.toString() ?? '';
    return Container(
      margin: const EdgeInsets.only(bottom: 12),
      padding: const EdgeInsets.all(16),
      decoration: BoxDecoration(color: Colors.white, borderRadius: BorderRadius.circular(18), border: Border.all(color: _border)),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              CircleAvatar(
                radius: 20,
                backgroundColor: _primary.withValues(alpha: 0.1),
                child: Text(
                  (p['customer_name']?.toString().isNotEmpty == true) ? p['customer_name'].toString()[0].toUpperCase() : 'P',
                  style: GoogleFonts.poppins(color: _primary, fontWeight: FontWeight.w700),
                ),
              ),
              const SizedBox(width: 12),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(p['customer_name']?.toString() ?? 'Passenger', style: GoogleFonts.poppins(fontWeight: FontWeight.w600, color: _textPri)),
                    const SizedBox(height: 2),
                    Text('${p['seats_requested'] ?? 1} seat(s) · ₹${double.tryParse('${p['total_fare'] ?? 0}')?.toStringAsFixed(0) ?? '0'}', style: GoogleFonts.poppins(fontSize: 12, color: _textSec)),
                  ],
                ),
              ),
              _statusBadge(status),
            ],
          ),
          const SizedBox(height: 12),
          Text('Pickup: ${p['pickup_address'] ?? '-'}', style: GoogleFonts.poppins(fontSize: 12, color: _textSec)),
          const SizedBox(height: 4),
          Text('Drop: ${p['drop_address'] ?? '-'}', style: GoogleFonts.poppins(fontSize: 12, color: _textSec)),
          const SizedBox(height: 14),
          Row(
            children: [
              if (status == 'matched') ...[
                Expanded(
                  child: OutlinedButton(
                    onPressed: requestId.isEmpty ? null : () => _markNoShow(requestId),
                    style: OutlinedButton.styleFrom(shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12))),
                    child: Text('No-show', style: GoogleFonts.poppins(fontWeight: FontWeight.w600)),
                  ),
                ),
                const SizedBox(width: 10),
                Expanded(
                  child: ElevatedButton(
                    onPressed: requestId.isEmpty ? null : () => _pickupPassenger(requestId),
                    style: ElevatedButton.styleFrom(backgroundColor: _primary, shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12))),
                    child: Text('Verify OTP', style: GoogleFonts.poppins(color: Colors.white, fontWeight: FontWeight.w600)),
                  ),
                ),
              ] else if (status == 'picked_up') ...[
                Expanded(
                  child: ElevatedButton(
                    onPressed: requestId.isEmpty ? null : () => _dropPassenger(requestId),
                    style: ElevatedButton.styleFrom(backgroundColor: const Color(0xFF16A34A), shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12))),
                    child: Text('Drop Passenger', style: GoogleFonts.poppins(color: Colors.white, fontWeight: FontWeight.w600)),
                  ),
                ),
              ],
            ],
          ),
        ],
      ),
    );
  }

  Widget _statusBadge(String status) {
    Color color;
    switch (status) {
      case 'picked_up':
        color = const Color(0xFF16A34A);
        break;
      case 'matched':
        color = _primary;
        break;
      default:
        color = const Color(0xFF6B7280);
    }
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 5),
      decoration: BoxDecoration(
        color: color.withValues(alpha: 0.10),
        borderRadius: BorderRadius.circular(10),
        border: Border.all(color: color.withValues(alpha: 0.20)),
      ),
      child: Text(
        status.replaceAll('_', ' '),
        style: GoogleFonts.poppins(fontSize: 11, fontWeight: FontWeight.w600, color: color),
      ),
    );
  }
}
