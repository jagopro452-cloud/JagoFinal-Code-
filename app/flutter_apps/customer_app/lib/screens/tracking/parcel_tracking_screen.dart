import 'dart:async';
import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:http/http.dart' as http;

import '../../config/jago_theme.dart';
import '../../config/api_config.dart';
import '../../services/auth_service.dart';
import '../../services/socket_service.dart';
import '../../services/trip_service.dart';
import '../main_screen.dart';

class ParcelTrackingScreen extends StatefulWidget {
  final String orderId;
  const ParcelTrackingScreen({super.key, required this.orderId});

  @override
  State<ParcelTrackingScreen> createState() => _ParcelTrackingScreenState();
}

class _ParcelTrackingScreenState extends State<ParcelTrackingScreen>
    with WidgetsBindingObserver {
  Timer? _pollTimer;
  final SocketService _socket = SocketService();
  final List<StreamSubscription> _subs = [];
  bool _loading = true;
  bool _cancelLoading = false;
  String? _error;
  Map<String, dynamic>? _order;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    _fetchOrder();
    _pollTimer = Timer.periodic(const Duration(seconds: 5), (_) => _fetchOrder());
    _subs.add(_socket.onParcelStatus.listen((data) {
      if (!mounted) return;
      if ((data['orderId']?.toString() ?? '') != widget.orderId) return;
      _fetchOrder();
    }));
    _subs.add(_socket.onParcelLocation.listen((data) {
      if (!mounted) return;
      if ((data['orderId']?.toString() ?? '') != widget.orderId) return;
      _fetchOrder();
    }));
    _socket.connect(ApiConfig.socketUrl).then((_) {
      _socket.trackParcel(widget.orderId);
    });
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state == AppLifecycleState.resumed) {
      _fetchOrder();
      _socket.connect(ApiConfig.socketUrl).then((_) {
        _socket.trackParcel(widget.orderId);
      });
    }
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    _pollTimer?.cancel();
    for (final sub in _subs) {
      sub.cancel();
    }
    _socket.stopTrackingParcel(widget.orderId);
    super.dispose();
  }

  String get _status => _order?['currentStatus']?.toString() ?? 'searching';

  bool get _canCancel => _status == 'pending' || _status == 'searching';

  Future<void> _fetchOrder() async {
    try {
      final headers = await AuthService.getHeaders();
      final res = await http
          .get(Uri.parse(ApiConfig.parcelTrack(widget.orderId)), headers: headers)
          .timeout(const Duration(seconds: 10));
      if (!mounted) return;
      if (res.statusCode == 200) {
        final data = jsonDecode(res.body) as Map<String, dynamic>;
        final order = data['order'];
        setState(() {
          _order = order is Map<String, dynamic> ? order : null;
          _loading = false;
          _error = null;
        });
        if (_status == 'completed' || _status == 'cancelled') {
          _pollTimer?.cancel();
        }
      } else {
        setState(() {
          _loading = false;
          _error = 'Could not load parcel status.';
        });
      }
    } catch (_) {
      if (!mounted) return;
      setState(() {
        _loading = false;
        _error = 'Network error while loading parcel status.';
      });
    }
  }

  Future<void> _cancelOrder() async {
    if (_cancelLoading) return;
    setState(() => _cancelLoading = true);
    final result = await TripService.cancelParcelOrder(
      widget.orderId,
      reason: 'Customer cancelled to continue with a new booking',
    );
    if (!mounted) return;
    setState(() => _cancelLoading = false);
    if (result['success'] == true) {
      Navigator.pushAndRemoveUntil(
        context,
        MaterialPageRoute(builder: (_) => const MainScreen()),
        (_) => false,
      );
      return;
    }
    final message = result['message']?.toString() ?? result['error']?.toString() ?? 'Could not cancel parcel order.';
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(content: Text(message), behavior: SnackBarBehavior.floating),
    );
  }

  Color _statusColor(String status) {
    switch (status) {
      case 'completed':
        return const Color(0xFF16A34A);
      case 'cancelled':
        return const Color(0xFFDC2626);
      case 'driver_assigned':
      case 'accepted':
      case 'picked_up':
      case 'in_transit':
        return JT.primary;
      default:
        return const Color(0xFFF59E0B);
    }
  }

  String _statusLabel(String status) {
    switch (status) {
      case 'driver_assigned':
        return 'Driver assigned';
      case 'picked_up':
        return 'Parcel picked up';
      case 'in_transit':
        return 'Parcel in transit';
      default:
        return status.replaceAll('_', ' ');
    }
  }

  Widget _infoCard({
    required IconData icon,
    required String title,
    required String value,
  }) {
    return Container(
      padding: const EdgeInsets.all(16),
      decoration: BoxDecoration(
        color: Colors.white,
        borderRadius: BorderRadius.circular(18),
        border: Border.all(color: const Color(0xFFE5E7EB)),
      ),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Icon(icon, color: JT.primaryDark, size: 20),
          const SizedBox(width: 12),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(title, style: const TextStyle(fontSize: 12, color: Color(0xFF64748B))),
                const SizedBox(height: 4),
                Text(value, style: const TextStyle(fontSize: 14, fontWeight: FontWeight.w600)),
              ],
            ),
          ),
        ],
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final order = _order;
    final drops = (order?['drops'] as List<dynamic>? ?? const []).cast<dynamic>();
    final driverName = order?['driverName']?.toString() ?? '';
    final driverPhone = order?['driverPhone']?.toString() ?? '';

    return Scaffold(
      backgroundColor: const Color(0xFFF8FAFC),
      appBar: AppBar(
        title: const Text('Track Parcel'),
        backgroundColor: Colors.white,
        foregroundColor: const Color(0xFF0F172A),
        elevation: 0,
      ),
      body: _loading
          ? const Center(child: CircularProgressIndicator())
          : _error != null
              ? Center(child: Padding(
                  padding: const EdgeInsets.all(24),
                  child: Text(_error!, textAlign: TextAlign.center),
                ))
              : RefreshIndicator(
                  onRefresh: _fetchOrder,
                  child: ListView(
                    padding: const EdgeInsets.all(16),
                    children: [
                      Container(
                        padding: const EdgeInsets.all(16),
                        decoration: BoxDecoration(
                          color: Colors.white,
                          borderRadius: BorderRadius.circular(20),
                        ),
                        child: Row(
                          children: [
                            Container(
                              padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
                              decoration: BoxDecoration(
                                color: _statusColor(_status).withValues(alpha: 0.12),
                                borderRadius: BorderRadius.circular(999),
                              ),
                              child: Text(
                                _statusLabel(_status),
                                style: TextStyle(
                                  color: _statusColor(_status),
                                  fontWeight: FontWeight.w700,
                                ),
                              ),
                            ),
                            const Spacer(),
                            Text(
                              'Order ${widget.orderId.substring(0, widget.orderId.length > 8 ? 8 : widget.orderId.length).toUpperCase()}',
                              style: const TextStyle(fontSize: 12, color: Color(0xFF64748B)),
                            ),
                          ],
                        ),
                      ),
                      const SizedBox(height: 16),
                      _infoCard(
                        icon: Icons.location_on_outlined,
                        title: 'Pickup',
                        value: order?['pickupAddress']?.toString() ?? 'Pickup address unavailable',
                      ),
                      const SizedBox(height: 12),
                      ...drops.map((drop) => Padding(
                            padding: const EdgeInsets.only(bottom: 12),
                            child: _infoCard(
                              icon: Icons.flag_outlined,
                              title: 'Drop',
                              value: (drop is Map<String, dynamic>)
                                  ? (drop['address']?.toString() ?? 'Drop address unavailable')
                                  : 'Drop address unavailable',
                            ),
                          )),
                      if (driverName.isNotEmpty) ...[
                        const SizedBox(height: 4),
                        _infoCard(
                          icon: Icons.person_outline,
                          title: 'Driver',
                          value: driverPhone.isNotEmpty ? '$driverName • $driverPhone' : driverName,
                        ),
                      ],
                      const SizedBox(height: 12),
                      _infoCard(
                        icon: Icons.payments_outlined,
                        title: 'Fare',
                        value: '₹${order?['totalFare']?.toString() ?? '0'}',
                      ),
                      const SizedBox(height: 24),
                      if (_canCancel)
                        SizedBox(
                          height: 52,
                          child: ElevatedButton(
                            onPressed: _cancelLoading ? null : _cancelOrder,
                            style: ElevatedButton.styleFrom(
                              backgroundColor: const Color(0xFFDC2626),
                              shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(16)),
                            ),
                            child: _cancelLoading
                                ? const SizedBox(
                                    width: 20,
                                    height: 20,
                                    child: CircularProgressIndicator(strokeWidth: 2, color: Colors.white),
                                  )
                                : const Text('Cancel Parcel Order', style: TextStyle(color: Colors.white)),
                          ),
                        ),
                      if (!_canCancel)
                        SizedBox(
                          height: 52,
                          child: ElevatedButton(
                            onPressed: () => Navigator.pushAndRemoveUntil(
                              context,
                              MaterialPageRoute(builder: (_) => const MainScreen()),
                              (_) => false,
                            ),
                            style: ElevatedButton.styleFrom(
                              backgroundColor: JT.primary,
                              shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(16)),
                            ),
                            child: const Text('Back To Home', style: TextStyle(color: Colors.white)),
                          ),
                        ),
                    ],
                  ),
                ),
    );
  }
}
