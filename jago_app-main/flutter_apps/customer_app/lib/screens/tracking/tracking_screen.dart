import 'dart:async';
import 'dart:convert';
import 'dart:math' as math;
import 'dart:ui' as ui;
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_tts/flutter_tts.dart';
import 'package:google_fonts/google_fonts.dart';
import 'package:google_maps_flutter/google_maps_flutter.dart';
import 'package:http/http.dart' as http;
import 'package:url_launcher/url_launcher.dart';
import '../../config/api_config.dart';
import '../../config/jago_theme.dart';
import '../../services/auth_service.dart';
import '../../services/socket_service.dart';
import '../../services/alarm_service.dart';
import '../../services/call_service.dart';
import '../call/call_screen.dart';
import '../chat/trip_chat_sheet.dart';

import '../main_screen.dart';
import '../booking/booking_screen.dart';
import 'trip_completion_screen.dart';

class TrackingScreen extends StatefulWidget {
  final String tripId;
  const TrackingScreen({super.key, required this.tripId});
  @override
  State<TrackingScreen> createState() => _TrackingScreenState();
}

class _TrackingScreenState extends State<TrackingScreen>
    with TickerProviderStateMixin, WidgetsBindingObserver {
  final SocketService _socket = SocketService();
  GoogleMapController? _mapController;
  LatLng _center = const LatLng(17.3850, 78.4867);
  LatLng? _driverLatLng;
  String _status = 'searching';
  Map<String, dynamic>? _trip;
  double _walletPendingAmount =
      0; // amount customer still owes after wallet deduction
  List<String> _cancelReasons = [];
  late AnimationController _pulseCtrl;
  final Set<Marker> _markers = {};
  final Set<Polyline> _polylines = {};
  final List<StreamSubscription> _subs = [];
  final FlutterTts _tts = FlutterTts();
  StreamSubscription? _incomingCallSub;

  // Booking timeout warning (Feature 1) & Boost Fare (Feature 2)
  Timer? _searchTimeoutTimer;
  bool _boostLoading = false;
  Timer? _nearbyDriversTimer;
  Timer? _driverAnimationTimer;
  final Map<String, BitmapDescriptor> _markerIconCache = {};
  List<Map<String, dynamic>> _nearbyDrivers = [];
  double _driverHeading = 0;

  bool _isConnected = true;
  StreamSubscription? _connSub;
  Timer? _pollTimer;

  bool _isArriving = false; // "Pilot is about to arrive" flag

  // Custom Top Banner state
  String? _bannerMessage;
  Color _bannerColor = JT.primary;
  Timer? _bannerTimer;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    _initTts();
    _pulseCtrl =
        AnimationController(vsync: this, duration: const Duration(seconds: 2))
          ..repeat(reverse: true);
    _connSub = _socket.onConnectionChanged.listen((connected) {
      if (mounted) {
        setState(() => _isConnected = connected);
        if (!connected) {
          _showStatusBanner('Waiting for connection...', Colors.orange);
        } else {
          _showStatusBanner('Reconnected!', const Color(0xFF10B981));
          // Re-join trip room on every reconnect
          _socket.trackTrip(widget.tripId);
          // Triple poll to reconcile state quickly
          _pollStatus();
          Future.delayed(const Duration(milliseconds: 800), _pollStatus);
          Future.delayed(const Duration(milliseconds: 2500), _pollStatus);
        }
      }
    });
    _connectSocket();
    _pollStatus();
    _loadCancelReasons();
    CallService().init();
    _listenForIncomingCalls();
    // HTTP polling as fallback — 2s for active states, 4s for in-progress
    // Socket handles real-time but poll catches missed events and reconciles data
    _pollTimer = Timer.periodic(const Duration(seconds: 2), (_) => _pollStatus());
    // Start 90-second timeout warning for searching state
    _startSearchTimeoutTimer();
    _startNearbyDriversPolling();
  }

  void _connectSocket() {
    CallService().init();
    // Eagerly join the trip room
    _socket.trackTrip(widget.tripId);

    _subs.add(_socket.onDriverLocation.listen((data) {
      if (!mounted) return;
      final lat = double.tryParse(data['lat']?.toString() ?? '');
      final lng = double.tryParse(data['lng']?.toString() ?? '');
      final heading =
          double.tryParse(data['heading']?.toString() ?? '') ?? _driverHeading;
      if (lat != null && lng != null) {
        _checkArrivingStatus(lat, lng);
        _setDriverLocation(
          LatLng(lat, lng),
          heading: heading,
          animate: true,
        );
      }
    }));

    _subs.add(_socket.onTripStatus.listen((data) {
      if (data == null) return;
      try {
        final newStatus = data['status']?.toString();
        if (newStatus == null) return;

        // Status rank guard: ensure we only move forward in the lifecycle
        const statusRank = {
          'searching': 0,
          'driver_assigned': 1,
          'accepted': 2,
          'arrived': 3,
          'in_progress': 4,
          'on_the_way': 4,
          'completed': 5,
          'cancelled': 5
        };
        final incomingRank = statusRank[newStatus] ?? 0;
        final currentRank = statusRank[_status] ?? 0;

        if (incomingRank < currentRank) {
          debugPrint(
              '[SOCKET] Ignoring stale status update: $newStatus (current: $_status)');
          return;
        }

        if (newStatus != _status) {
          debugPrint('[SOCKET] Trip status transition: $_status -> $newStatus');
        setState(() {
          _status = newStatus;

            final Map<String, dynamic> update = {};

            // Merge driver data if present in payload
            if (data['driver'] is Map) {
              final driverMap = Map<String, dynamic>.from(data['driver']);
              update['driverId'] = driverMap['id']?.toString() ??
                  driverMap['userId']?.toString();
              update['driverName'] =
                  driverMap['fullName'] ?? driverMap['full_name'] ?? '';
              update['driverPhone'] = driverMap['phone'] ?? '';
              update['driverRating'] =
                  driverMap['rating'] ?? driverMap['avgRating'];
              update['driverPhoto'] =
                  driverMap['photo'] ?? driverMap['profilePhoto'] ?? '';
              update['driverVehicleNumber'] = driverMap['vehicleNumber'] ??
                  driverMap['vehicle_number'] ??
                  '';
              update['driverVehicleModel'] =
                  driverMap['vehicleModel'] ?? driverMap['vehicle_model'] ?? '';
              update['vehicleName'] = driverMap['vehicleCategory'] ??
                  driverMap['vehicle_category'] ??
                  '';
              update['driverLat'] = driverMap['lat'];
              update['driverLng'] = driverMap['lng'];

              final double? dLat =
                  double.tryParse(update['driverLat']?.toString() ?? '');
              final double? dLng =
                  double.tryParse(update['driverLng']?.toString() ?? '');
              if (dLat != null && dLng != null && dLat != 0) {
                _driverLatLng = LatLng(dLat, dLng);
              }
            }

            // Merge OTP if present (verify-pickup-otp transition)
            final String? incomingOtp =
                data['otp']?.toString() ?? data['pickupOtp']?.toString();
            if (incomingOtp != null && incomingOtp.isNotEmpty) {
              update['pickupOtp'] = incomingOtp;
            }

            if (newStatus == 'completed') {
              _walletPendingAmount = double.tryParse(
                      data['walletPendingAmount']?.toString() ??
                          data['pendingPaymentAmount']?.toString() ??
                          '0') ??
                  _walletPendingAmount;
            }

            _trip = (_trip != null) ? {..._trip!, ...update} : update;
        });

        if (!_isRideSafetyCallActive(newStatus) &&
            CallService().activeCallTripId == widget.tripId) {
          CallService().hangUp();
        }

          // UI transitions & feedback
          _handleStatusTransition(newStatus);
          HapticFeedback.lightImpact();
          // Immediately reconcile — don't wait for next poll tick.
          _pollStatus();
          Future.delayed(const Duration(milliseconds: 1500), _pollStatus);
          Future.delayed(const Duration(milliseconds: 3000), _pollStatus);
        }

        if (newStatus == 'completed' || newStatus == 'cancelled') {
          _pollTimer?.cancel();
          _pollStatus();
        }
      } catch (e, stack) {
        debugPrint('[SOCKET] Error in onTripStatus: $e\n$stack');
      }
    }));

    // Detailed driver assignment info
    _subs.add(_socket.onDriverAssigned.listen((data) {
      if (!mounted) return;
      _searchTimeoutTimer?.cancel();
      final driverData = data['driver'];
      final driverId = data['driverId']?.toString();
      final driverMap =
          driverData is Map ? Map<String, dynamic>.from(driverData) : null;
      final pickupOtp =
          data['pickupOtp']?.toString() ?? data['otp']?.toString();

      setState(() {
        _status = data['status'] ?? data['currentStatus'] ?? 'accepted';
        final Map<String, dynamic> update = {};
        if (pickupOtp != null && pickupOtp.isNotEmpty)
          update['pickupOtp'] = pickupOtp;
        if (driverId != null) update['driverId'] = driverId;

        if (driverMap != null) {
          update['driverName'] = driverMap['fullName'] ??
              driverMap['full_name'] ??
              driverMap['name'] ??
              'Jago Pilot';
          update['driverPhone'] =
              driverMap['phone'] ?? driverMap['mobile'] ?? '';
          update['driverRating'] =
              driverMap['rating'] ?? driverMap['avgRating'] ?? 5.0;
          update['driverPhoto'] =
              driverMap['photo'] ?? driverMap['profilePhoto'] ?? '';
          update['driverVehicleNumber'] = driverMap['vehicleNumber'] ??
              driverMap['vehicle_number'] ??
              driverMap['vehicle_no'] ??
              '';
          update['driverVehicleModel'] = driverMap['vehicleModel'] ??
              driverMap['vehicle_model'] ??
              driverMap['model'] ??
              '';
          update['vehicleName'] = driverMap['vehicleCategory'] ??
              driverMap['vehicle_category'] ??
              driverMap['vehicle_name'] ??
              'Pilot';
          update['driverLat'] = driverMap['lat'];
          update['driverLng'] = driverMap['lng'];
          update['driverHeading'] =
              driverMap['heading'] ?? driverMap['driverHeading'];
        } else {
          update['driverName'] =
              data['driverName'] ?? data['driver_name'] ?? 'Jago Pilot';
          update['driverPhone'] = data['driverPhone'] ?? data['driver_phone'];
          update['driverRating'] = data['driverRating'] ?? data['driver_rating'];
          update['driverPhoto'] = data['driverPhoto'] ?? data['driver_photo'];
          update['driverVehicleNumber'] =
              data['driverVehicleNumber'] ?? data['driver_vehicle_number'];
          update['driverVehicleModel'] =
              data['driverVehicleModel'] ?? data['driver_vehicle_model'];
          update['vehicleName'] =
              data['vehicleName'] ?? data['vehicle_name'] ?? 'Pilot';
        }

        if (_trip != null) {
          _trip = {..._trip!, ...update};
        } else {
          _trip = update;
        }
      });

      final dLat = double.tryParse(_trip?['driverLat']?.toString() ?? '');
      final dLng = double.tryParse(_trip?['driverLng']?.toString() ?? '');
      if (dLat != null && dLng != null && dLat != 0) {
        _setDriverLocation(
          LatLng(dLat, dLng),
          heading:
              double.tryParse(_trip?['driverHeading']?.toString() ?? '') ??
                  _driverHeading,
          animate: false,
        );
      }

      _showStatusBanner('Pilot accepted your ride', JT.primary);
      AlarmService().playChime();
      HapticFeedback.heavyImpact();
      _announceStatus('accepted');
      // Immediate reconciliation poll to load driver details + route data
      _pollStatus();
      // Also fetch route using the driver's current location if available
      if (_driverLatLng != null) _fetchRouteForStatus();
    }));

    _subs.add(_socket.onTripCancelled.listen((_) {
      if (!mounted) return;
      setState(() => _status = 'cancelled');
      _pollTimer?.cancel();
      _showStatusBanner('Trip was cancelled', Colors.red);
      _announceStatus('cancelled');
    }));

    _socket.connect(ApiConfig.socketUrl).then((_) {
      // Refresh state after connection establishes
      _socket.trackTrip(widget.tripId);
      _pollStatus();
    });

    // Re-searching for driver (after rejection)
    _subs.add(_socket.onTripSearching.listen((data) {
      if (!mounted) return;
      setState(() => _status = 'searching');
      // Restart the 90s timeout warning since we're back to searching
      _startSearchTimeoutTimer();
    }));

    // No drivers available — trip auto-cancelled
    _subs.add(_socket.onNoDrivers.listen((data) {
      if (!mounted) return;
      setState(() => _status = 'cancelled');
      _pollTimer?.cancel();
      _showNoDriversDialog();
    }));
  }

  // No drivers available → set cancelled state (UI handled by _buildCancelledCard)
  void _showNoDriversDialog() {
    if (!mounted) return;
    setState(() => _status = 'cancelled');
    _showStatusBanner('No pilots nearby. Try again!', const Color(0xFFDC2626));
  }

  // Retry booking using the same trip's original params
  void _retryBooking() {
    final t = _trip;
    if (t == null) {
      Navigator.pushAndRemoveUntil(context,
          MaterialPageRoute(builder: (_) => const MainScreen()), (_) => false);
      return;
    }
    Navigator.pushAndRemoveUntil(
      context,
      MaterialPageRoute(
        builder: (_) => BookingScreen(
          pickup: t['pickupAddress']?.toString() ??
              t['pickup_address']?.toString() ??
              'Pickup',
          destination: t['destinationAddress']?.toString() ??
              t['destination_address']?.toString() ??
              'Destination',
          pickupLat: double.tryParse(t['pickupLat']?.toString() ?? '') ?? 0.0,
          pickupLng: double.tryParse(t['pickupLng']?.toString() ?? '') ?? 0.0,
          destLat:
              double.tryParse(t['destinationLat']?.toString() ?? '') ?? 0.0,
          destLng:
              double.tryParse(t['destinationLng']?.toString() ?? '') ?? 0.0,
          vehicleCategoryId: t['vehicleCategoryId']?.toString(),
          vehicleCategoryName: t['vehicleName']?.toString(),
          category: (t['tripType']?.toString() == 'parcel' ||
                  t['trip_type']?.toString() == 'parcel')
              ? 'parcel'
              : 'ride',
        ),
      ),
      (_) => false,
    );
  }

  Future<void> _startNearbyDriversPolling() async {
    _nearbyDriversTimer?.cancel();
    if (!mounted || _status != 'searching') return;
    _fetchNearbyDrivers();
    _nearbyDriversTimer = Timer.periodic(const Duration(seconds: 5), (_) {
      if (_status == 'searching') {
        _fetchNearbyDrivers();
      } else {
        _nearbyDriversTimer?.cancel();
      }
    });
  }

  Future<void> _fetchNearbyDrivers() async {
    if (!mounted || _status != 'searching') return;
    try {
      final pLat = double.tryParse(_trip?['pickupLat']?.toString() ?? '');
      final pLng = double.tryParse(_trip?['pickupLng']?.toString() ?? '');
      if (pLat == null || pLng == null) return;
      final vehicleCategoryId = _trip?['vehicleCategoryId']?.toString() ??
          _trip?['vehicle_category_id']?.toString();

      final headers = await AuthService.getHeaders();
      final queryParameters = <String, String>{
        'lat': pLat.toString(),
        'lng': pLng.toString(),
        'radius': '3',
      };
      if (vehicleCategoryId != null && vehicleCategoryId.isNotEmpty) {
        queryParameters['vehicleCategoryId'] = vehicleCategoryId;
      }
      final uri = Uri.parse(ApiConfig.nearbyDrivers)
          .replace(queryParameters: queryParameters);
      final r = await http
          .get(uri, headers: headers)
          .timeout(const Duration(seconds: 5));
      if (!mounted || r.statusCode != 200) return;

      final data = jsonDecode(r.body) as Map<String, dynamic>;
      final drivers =
          (data['drivers'] as List<dynamic>?)?.cast<Map<String, dynamic>>() ??
              [];
      setState(() => _nearbyDrivers = drivers);
      _updateMapMarkers();
    } catch (_) {}
  }

  Future<BitmapDescriptor> _getMarkerIcon(String type,
      {bool isSearching = false}) async {
    final key = "${type}_$isSearching";
    if (_markerIconCache.containsKey(key)) return _markerIconCache[key]!;
    final icon = await _drawMarkerIcon(type, isSearching: isSearching);
    _markerIconCache[key] = icon;
    return icon;
  }

  Future<BitmapDescriptor> _drawMarkerIcon(String type,
      {bool isSearching = false}) async {
    const double size = 110.0;
    final recorder = ui.PictureRecorder();
    final canvas = Canvas(recorder, const Rect.fromLTWH(0, 0, size, size));

    final shadowPaint = Paint()
      ..color = Colors.black.withValues(alpha: 0.18)
      ..maskFilter = const MaskFilter.blur(BlurStyle.normal, 7);
    canvas.drawCircle(
        const Offset(size / 2, size / 2 + 3), size / 2 - 10, shadowPaint);

    final bgPaint = Paint()
      ..color = isSearching ? const Color(0xFF2F7BFF) : const Color(0xFF1E40AF);
    canvas.drawCircle(const Offset(size / 2, size / 2), size / 2 - 12, bgPaint);

    final borderPaint = Paint()
      ..color = Colors.white
      ..style = PaintingStyle.stroke
      ..strokeWidth = 3;
    canvas.drawCircle(
        const Offset(size / 2, size / 2), size / 2 - 12, borderPaint);

    final t = type.toLowerCase();
    final emoji = t.contains('auto') ? '🛺'
        : t.contains('bike') || t.contains('moto') || t.contains('scooter') ? '🏍️'
        : t.contains('parcel') ? '📦'
        : t.contains('cargo') || t.contains('truck') || t.contains('tempo') ? '🚚'
        : t.contains('intercity') || t.contains('outstation') ? '🚘'
        : '🚗';
    final tp = TextPainter(
        text: TextSpan(text: emoji, style: const TextStyle(fontSize: 48)),
        textDirection: TextDirection.ltr)
      ..layout();
    tp.paint(canvas, Offset((size - tp.width) / 2, (size - tp.height) / 2));

    final img =
        await recorder.endRecording().toImage(size.toInt(), size.toInt());
    final data = await img.toByteData(format: ui.ImageByteFormat.png);
    return BitmapDescriptor.bytes(data!.buffer.asUint8List());
  }

  Future<BitmapDescriptor> _pickupMarkerIcon() async {
    const double size = 100.0;
    final recorder = ui.PictureRecorder();
    final canvas = Canvas(recorder, const Rect.fromLTWH(0, 0, size, size));
    final paint = Paint()..color = const Color(0xFF2F7BFF);
    canvas.drawCircle(const Offset(size / 2, size / 2), size / 2 - 10,
        paint..style = PaintingStyle.fill);
    canvas.drawCircle(
        const Offset(size / 2, size / 2),
        size / 2 - 10,
        Paint()
          ..color = Colors.white
          ..style = PaintingStyle.stroke
          ..strokeWidth = 4);
    final tp = TextPainter(
        text: const TextSpan(text: '🔍', style: TextStyle(fontSize: 40)),
        textDirection: TextDirection.ltr)
      ..layout();
    tp.paint(canvas, Offset((size - tp.width) / 2, (size - tp.height) / 2));
    final img =
        await recorder.endRecording().toImage(size.toInt(), size.toInt());
    final data = await img.toByteData(format: ui.ImageByteFormat.png);
    return BitmapDescriptor.bytes(data!.buffer.asUint8List());
  }

  void _handleStatusTransition(String newStatus) {
    if (newStatus == 'accepted' || newStatus == 'driver_assigned') {
      _showStatusBanner('Pilot accepted your ride', JT.primary);
      _announceStatus('accepted');
      _updateMapMarkers();
    } else if (newStatus == 'arrived') {
      _showStatusBanner('Your pilot has arrived', const Color(0xFF10B981));
      _announceStatus('arrived');
      _updateMapMarkers();
    } else if (newStatus == 'in_progress' || newStatus == 'on_the_way') {
      _animateToDestination();
      _showStatusBanner('Ride started • Have a safe journey!', JT.primary);
      _fetchRouteForStatus();
      _updateMapMarkers();
    } else if (newStatus == 'completed') {
      _showStatusBanner('Trip Completed • Thank you!', const Color(0xFF10B981));
      setState(() => _polylines.clear());
      _updateMapMarkers();
      
      // Navigate to premium completion screen
      Future.delayed(const Duration(milliseconds: 800), () {
        if (mounted) {
          Navigator.pushReplacement(
            context,
            MaterialPageRoute(
              builder: (_) => TripCompletionScreen(
                trip: _trip ?? {'id': widget.tripId},
                walletPendingAmount: _walletPendingAmount,
              ),
            ),
          );
        }
      });
    } else if (newStatus == 'cancelled') {
      _showStatusBanner('Trip Cancelled', const Color(0xFFDC2626));
      setState(() => _polylines.clear());
    }
  }

  // ── Polyline & Routing ────────────────────────────────────────────────────

  List<LatLng> _decodePolyline(String encoded) {
    final List<LatLng> pts = [];
    int index = 0;
    int lat = 0, lng = 0;
    while (index < encoded.length) {
      int b, shift = 0, result = 0;
      do {
        b = encoded.codeUnitAt(index++) - 63;
        result |= (b & 0x1f) << shift;
        shift += 5;
      } while (b >= 0x20);
      final dLat = ((result & 1) != 0 ? ~(result >> 1) : (result >> 1));
      lat += dLat;
      shift = 0;
      result = 0;
      do {
        b = encoded.codeUnitAt(index++) - 63;
        result |= (b & 0x1f) << shift;
        shift += 5;
      } while (b >= 0x20);
      final dLng = ((result & 1) != 0 ? ~(result >> 1) : (result >> 1));
      lng += dLng;
      pts.add(LatLng(lat / 1e5, lng / 1e5));
    }
    return pts;
  }

  Future<void> _fetchRouteForStatus() async {
    if (_driverLatLng == null || _trip == null) return;

    // Status rank: search=0, assigned/accepted=1/2, arrived=3, on_the_way=4
    final isGoingToPickup = _status == 'accepted' ||
        _status == 'driver_assigned' ||
        _status == 'arrived';
    final isGoingToDrop = _status == 'in_progress' || _status == 'on_the_way';

    if (!isGoingToPickup && !isGoingToDrop) {
      if (_polylines.isNotEmpty) setState(() => _polylines.clear());
      return;
    }

    double destLat, destLng;
    if (isGoingToPickup) {
      destLat = double.tryParse(_trip?['pickupLat']?.toString() ?? '') ?? 0.0;
      destLng = double.tryParse(_trip?['pickupLng']?.toString() ?? '') ?? 0.0;
    } else {
      destLat =
          double.tryParse(_trip?['destinationLat']?.toString() ?? '') ?? 0.0;
      destLng =
          double.tryParse(_trip?['destinationLng']?.toString() ?? '') ?? 0.0;
    }

    if (destLat == 0 || destLng == 0) return;

    // Fetch route from driver to target
    await _fetchRoute(
        _driverLatLng!.latitude, _driverLatLng!.longitude, destLat, destLng);
  }

  Future<void> _fetchRoute(
      double fromLat, double fromLng, double toLat, double toLng) async {
    try {
      final headers = await AuthService.getHeaders();
      final res = await http
          .post(
            Uri.parse(ApiConfig.routeMultiWaypoint),
            headers: {...headers, 'Content-Type': 'application/json'},
            body: jsonEncode({
              'origin': {'lat': fromLat, 'lng': fromLng},
              'destination': {'lat': toLat, 'lng': toLng},
              'waypoints': [],
              'optimize': false,
            }),
          )
          .timeout(const Duration(seconds: 8));

      if (res.statusCode == 200) {
        final data = jsonDecode(res.body) as Map<String, dynamic>;
        final overviewPolyline = data['overviewPolyline']?.toString();
        if (overviewPolyline != null && mounted) {
          final pts = _decodePolyline(overviewPolyline);
          setState(() {
            _polylines.clear();
            _polylines.add(Polyline(
              polylineId: const PolylineId('route'),
              points: pts,
              color: JT.primary,
              width: 5,
              jointType: JointType.round,
              startCap: Cap.roundCap,
              endCap: Cap.roundCap,
            ));
          });

          // Fit markers and route in view if significant movement occurred
          _fitMarkersToScreen();
        }
      }
    } catch (_) {}
  }

  void _fitMarkersToScreen() {
    if (_mapController == null || _driverLatLng == null) return;

    final pLat = double.tryParse(_trip?['pickupLat']?.toString() ?? '') ?? 0.0;
    final pLng = double.tryParse(_trip?['pickupLng']?.toString() ?? '') ?? 0.0;
    final dLat =
        double.tryParse(_trip?['destinationLat']?.toString() ?? '') ?? 0.0;
    final dLng =
        double.tryParse(_trip?['destinationLng']?.toString() ?? '') ?? 0.0;

    double targetLat =
        (_status == 'in_progress' || _status == 'on_the_way') ? dLat : pLat;
    double targetLng =
        (_status == 'in_progress' || _status == 'on_the_way') ? dLng : pLng;

    if (targetLat == 0) return;

    final bounds = LatLngBounds(
      southwest: LatLng(
        math.min(_driverLatLng!.latitude, targetLat),
        math.min(_driverLatLng!.longitude, targetLng),
      ),
      northeast: LatLng(
        math.max(_driverLatLng!.latitude, targetLat),
        math.max(_driverLatLng!.longitude, targetLng),
      ),
    );
    _mapController?.animateCamera(CameraUpdate.newLatLngBounds(bounds, 120));
  }

  void _setDriverLocation(
    LatLng target, {
    double? heading,
    bool animate = true,
  }) {
    final nextHeading = _normalizeHeading(heading ?? _driverHeading);
    final current = _driverLatLng;
    if (!animate || current == null) {
      _driverAnimationTimer?.cancel();
      if (!mounted) return;
      setState(() {
        _driverLatLng = target;
        _driverHeading = nextHeading;
      });
      _updateMapMarkers();
      _fetchRouteForStatus();
      return;
    }

    final distanceMeters = _distanceMeters(current, target);
    if (distanceMeters < 2) {
      if (!mounted) return;
      setState(() {
        _driverLatLng = target;
        _driverHeading = nextHeading;
      });
      _updateMapMarkers();
      _fetchRouteForStatus();
      return;
    }

    _driverAnimationTimer?.cancel();
    const totalSteps = 12;
    const frameGap = Duration(milliseconds: 75);
    var step = 0;
    final start = current;
    final startHeading = _driverHeading;

    _driverAnimationTimer = Timer.periodic(frameGap, (timer) {
      if (!mounted) {
        timer.cancel();
        return;
      }
      step++;
      final t = step / totalSteps;
      final eased = Curves.easeOutCubic.transform(t.clamp(0.0, 1.0));
      final lat =
          start.latitude + ((target.latitude - start.latitude) * eased);
      final lng =
          start.longitude + ((target.longitude - start.longitude) * eased);

      setState(() {
        _driverLatLng = LatLng(lat, lng);
        _driverHeading = _interpolateHeading(startHeading, nextHeading, eased);
      });
      _updateMapMarkers();

      if (step >= totalSteps) {
        timer.cancel();
        _fetchRouteForStatus();
      }
    });
  }

  double _normalizeHeading(double heading) {
    final normalized = heading % 360;
    return normalized < 0 ? normalized + 360 : normalized;
  }

  double _interpolateHeading(double start, double end, double t) {
    final normalizedStart = _normalizeHeading(start);
    final normalizedEnd = _normalizeHeading(end);
    final delta = ((normalizedEnd - normalizedStart + 540) % 360) - 180;
    return _normalizeHeading(normalizedStart + (delta * t));
  }

  double _distanceMeters(LatLng from, LatLng to) {
    return _calculateDistance(
          from.latitude,
          from.longitude,
          to.latitude,
          to.longitude,
        ) *
        1000;
  }

  void _updateMapMarkers() async {
    final Set<Marker> newMarkers = {};

    // 1. Pickup Location Marker (Search center)
    final pLat = double.tryParse(_trip?['pickupLat']?.toString() ?? '');
    final pLng = double.tryParse(_trip?['pickupLng']?.toString() ?? '');
    if (pLat != null && pLng != null) {
      newMarkers.add(Marker(
        markerId: const MarkerId('pickup'),
        position: LatLng(pLat, pLng),
        icon: await _pickupMarkerIcon(),
        anchor: const Offset(0.5, 0.5),
      ));
      if (_status == 'searching' && _mapController != null) {
        _center = LatLng(pLat, pLng);
      }
    }

    // 2. Assigned Driver Marker
    if (_driverLatLng != null &&
        _status != 'searching' &&
        _status != 'cancelled') {
      final vName = (_trip?['vehicleName'] ?? 'Pilot').toString();
      newMarkers.add(Marker(
        markerId: const MarkerId('driver'),
        position: _driverLatLng!,
        icon: await _getMarkerIcon(vName),
        rotation: _driverHeading,
        anchor: const Offset(0.5, 0.5),
        flat: true,
      ));
      if (_status != 'completed') {
        _mapController
            ?.animateCamera(CameraUpdate.newLatLngZoom(_driverLatLng!, 16));
      }
    }

    // 3. Destination Marker (visible during and after trip)
    final dLat = double.tryParse(_trip?['destinationLat']?.toString() ??
        _trip?['destination_lat']?.toString() ??
        '');
    final dLng = double.tryParse(_trip?['destinationLng']?.toString() ??
        _trip?['destination_lng']?.toString() ??
        '');
    if (dLat != null &&
        dLng != null &&
        dLat != 0 &&
        (_status == 'in_progress' ||
            _status == 'on_the_way' ||
            _status == 'completed')) {
      newMarkers.add(Marker(
        markerId: const MarkerId('destination'),
        position: LatLng(dLat, dLng),
        icon: BitmapDescriptor.defaultMarkerWithHue(BitmapDescriptor.hueRed),
      ));

      if (_driverLatLng != null && _mapController != null) {
        final bounds = LatLngBounds(
          southwest: LatLng(
            _driverLatLng!.latitude < dLat ? _driverLatLng!.latitude : dLat,
            _driverLatLng!.longitude < dLng ? _driverLatLng!.longitude : dLng,
          ),
          northeast: LatLng(
            _driverLatLng!.latitude > dLat ? _driverLatLng!.latitude : dLat,
            _driverLatLng!.longitude > dLng ? _driverLatLng!.longitude : dLng,
          ),
        );
        _mapController
            ?.animateCamera(CameraUpdate.newLatLngBounds(bounds, 100));
      }
    }

    // 3. Nearby Pilots (visible only during searching)
    if (_status == 'searching') {
      for (final d in _nearbyDrivers) {
        final dLat = double.tryParse(d['lat']?.toString() ?? '');
        final dLng = double.tryParse(d['lng']?.toString() ?? '');
        if (dLat == null || dLng == null) continue;
        final id = d['id']?.toString() ?? '';
        final vName =
            (d['vehicleCategoryName'] ?? d['vehicleName'] ?? 'bike').toString();
        final heading = double.tryParse(d['heading']?.toString() ?? '0') ?? 0;
        newMarkers.add(Marker(
          markerId: MarkerId('nearby_$id'),
          position: LatLng(dLat, dLng),
          icon: await _getMarkerIcon(vName, isSearching: true),
          rotation: heading,
          anchor: const Offset(0.5, 0.5),
          flat: true,
        ));
      }
    }

    if (mounted) {
      setState(() {
        _markers.clear();
        _markers.addAll(newMarkers);
      });
    }
  }

  void _checkArrivingStatus(double dLat, double dLng) {
    if (_status != 'accepted' &&
        _status != 'driver_assigned' &&
        _status != 'arrived') return;

    final pLat = double.tryParse(_trip?['pickupLat']?.toString() ?? '');
    final pLng = double.tryParse(_trip?['pickupLng']?.toString() ?? '');
    if (pLat == null || pLng == null) return;

    final double dist =
        _calculateDistance(dLat, dLng, pLat, pLng); // result in km

    // If within 500 meters and not already marked as arriving
    if (dist < 0.5 && !_isArriving && _status != 'arrived') {
      setState(() => _isArriving = true);
      // _announceStatus('arriving');
      HapticFeedback.mediumImpact();
    } else if (dist >= 0.5 && _isArriving) {
      setState(() => _isArriving = false);
    }
  }

  double _calculateDistance(
      double lat1, double lon1, double lat2, double lon2) {
    const double p = 0.017453292519943295;
    final double a = 0.5 -
        math.cos((lat2 - lat1) * p) / 2 +
        math.cos(lat1 * p) *
            math.cos(lat2 * p) *
            (1 - math.cos((lon2 - lon1) * p)) /
            2;
    return 12742 * math.asin(math.sqrt(a));
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    for (final s in _subs) s.cancel();
    _incomingCallSub?.cancel();
    _pollTimer?.cancel();
    _searchTimeoutTimer?.cancel();
    _nearbyDriversTimer?.cancel();
    _driverAnimationTimer?.cancel();
    _pulseCtrl.dispose();
    _tts.stop();
    // Don't disconnect socket — it's a shared singleton
    super.dispose();
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state == AppLifecycleState.resumed) {
      if (!_socket.isConnected) {
        _socket.connect(ApiConfig.socketUrl);
      }
      _socket.trackTrip(widget.tripId);
      _pollStatus();
    }
  }

  void _listenForIncomingCalls() {
    _incomingCallSub = _socket.onCallIncoming.listen((data) {
      if (!mounted) return;
      final callerName = data['callerName']?.toString() ?? 'Driver';
      final callerId = data['callerId']?.toString() ?? '';
      final tripId = data['tripId']?.toString() ?? widget.tripId;
      Navigator.of(context).push(MaterialPageRoute(
        builder: (_) => CallScreen(
          contactName: callerName,
          tripId: tripId,
          targetUserId: callerId,
          isIncoming: true,
          callerIdForIncoming: callerId,
        ),
      ));
    });
  }

  bool _isRideSafetyCallActive(String status) => const {
        'driver_assigned',
        'accepted',
        'arrived',
        'in_progress',
        'on_the_way',
      }.contains(status);

  Future<void> _initTts() async {
    try {
      await _tts.setLanguage('en-IN');
      await _tts.setSpeechRate(0.44);
      await _tts.setPitch(1.0);
      await _tts.setVolume(1.0);
    } catch (_) {}
  }

  Future<void> _announceStatus(String status) async {
    /* 
    // Temporarily disabled to troubleshoot "Lost connection" crash on Android
    if (status == _lastAnnouncedStatus) return;
    _lastAnnouncedStatus = status;
    String? message;
    switch (status) {
      case 'driver_assigned':
      case 'accepted':
        message = 'Pilot accepted your ride and is on the way.';
        break;
      case 'arriving':
        message = 'Your pilot is about to arrive at your location.';
        break;
      case 'arrived':
        message = 'Your pilot is arrived at the pickup location.';
        break;
      case 'in_progress':
      case 'on_the_way':
        message = 'Your ride is started. Have a safe journey.';
        break;
      case 'completed':
        message = 'Your ride is ended. Thank you for choosing Jago.';
        break;
      case 'cancelled':
        message = 'Trip has been cancelled.';
        break;
    }
    if (message == null) return;
    try {
      await _tts.stop();
      await _tts.speak(message);
    } catch (_) {}
    */
  }

  // ── Feature 1: Booking Timeout Warning ────────────────────────────────────
  void _startSearchTimeoutTimer() {
    _searchTimeoutTimer?.cancel();
    _searchTimeoutTimer = Timer(const Duration(seconds: 90), () {
      if (!mounted || _status != 'searching') return;
      _showBookingTimeoutWarning();
    });
  }

  void _showBookingTimeoutWarning() {
    if (!mounted) return;
    showDialog(
      context: context,
      barrierDismissible: false,
      builder: (ctx) => AlertDialog(
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(20)),
        backgroundColor: Colors.white,
        title: Row(children: [
          Container(
            width: 40,
            height: 40,
            decoration: BoxDecoration(
              color: const Color(0xFFF59E0B).withValues(alpha: 0.12),
              shape: BoxShape.circle,
            ),
            child: const Icon(Icons.timer_outlined,
                color: Color(0xFFF59E0B), size: 22),
          ),
          const SizedBox(width: 12),
          Expanded(
            child: Text('Search is taking long',
                style: GoogleFonts.poppins(
                    fontSize: 15,
                    fontWeight: FontWeight.w500,
                    color: JT.textPrimary)),
          ),
        ]),
        content: Text(
          'We haven\'t found a pilot yet. You can boost your fare to attract more drivers, or cancel the trip.',
          style: GoogleFonts.poppins(
              fontSize: 13, color: const Color(0xFF6B7280), height: 1.5),
        ),
        actionsPadding: const EdgeInsets.fromLTRB(16, 0, 16, 16),
        actionsAlignment: MainAxisAlignment.spaceBetween,
        actions: [
          TextButton(
            onPressed: () {
              Navigator.pop(ctx);
              _showCancelDialog();
            },
            child: Text('Cancel Trip',
                style: GoogleFonts.poppins(
                    color: const Color(0xFFDC2626),
                    fontWeight: FontWeight.w400,
                    fontSize: 13)),
          ),
          ElevatedButton.icon(
            onPressed: () {
              Navigator.pop(ctx);
              _showBoostFareSheet();
            },
            icon: const Icon(Icons.bolt_rounded, size: 16),
            label: Text('Boost Fare',
                style: GoogleFonts.poppins(
                    fontWeight: FontWeight.w500, fontSize: 13)),
            style: ElevatedButton.styleFrom(
              backgroundColor: const Color(0xFF2F7BFF),
              foregroundColor: Colors.white,
              shape: RoundedRectangleBorder(
                  borderRadius: BorderRadius.circular(12)),
              padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 10),
            ),
          ),
        ],
      ),
    );
  }

  // ── Feature 2: Boost Fare ──────────────────────────────────────────────────
  Future<void> _boostFare(int amount) async {
    if (_boostLoading) return;
    setState(() => _boostLoading = true);
    try {
      final headers = await AuthService.getHeaders();
      final tripId = _trip?['id']?.toString() ?? widget.tripId;
      final res = await http.post(
        Uri.parse(ApiConfig.boostFare(tripId)),
        headers: headers,
        body: jsonEncode({'boostAmount': amount}),
      );
      if (!mounted) return;
      if (res.statusCode == 200) {
        ScaffoldMessenger.of(context).showSnackBar(SnackBar(
          content: Row(children: [
            const Icon(Icons.bolt_rounded, color: Colors.white, size: 16),
            const SizedBox(width: 8),
            Text('Fare boosted by ₹$amount! Searching for pilots...',
                style: GoogleFonts.poppins(
                    color: Colors.white,
                    fontWeight: FontWeight.w400,
                    fontSize: 13)),
          ]),
          backgroundColor: const Color(0xFF2F7BFF),
          behavior: SnackBarBehavior.floating,
          margin: const EdgeInsets.fromLTRB(16, 0, 16, 16),
          shape:
              RoundedRectangleBorder(borderRadius: BorderRadius.circular(12)),
          duration: const Duration(seconds: 4),
        ));
        // Restart the 90s timer after boost
        _startSearchTimeoutTimer();
      } else {
        final err = jsonDecode(res.body);
        ScaffoldMessenger.of(context).showSnackBar(SnackBar(
          content: Text(
              err['message']?.toString() ?? 'Boost failed. Try again.',
              style: GoogleFonts.poppins(color: Colors.white, fontSize: 13)),
          backgroundColor: const Color(0xFFDC2626),
          behavior: SnackBarBehavior.floating,
          margin: const EdgeInsets.fromLTRB(16, 0, 16, 16),
          shape:
              RoundedRectangleBorder(borderRadius: BorderRadius.circular(12)),
        ));
      }
    } catch (_) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(SnackBar(
          content: Text('Network error. Try again.',
              style: GoogleFonts.poppins(color: Colors.white, fontSize: 13)),
          backgroundColor: const Color(0xFFDC2626),
          behavior: SnackBarBehavior.floating,
          margin: const EdgeInsets.fromLTRB(16, 0, 16, 16),
          shape:
              RoundedRectangleBorder(borderRadius: BorderRadius.circular(12)),
        ));
      }
    }
    if (mounted) setState(() => _boostLoading = false);
  }

  void _showBoostFareSheet() {
    if (!mounted) return;
    showModalBottomSheet(
      context: context,
      backgroundColor: Colors.transparent,
      builder: (_) => Container(
        decoration: BoxDecoration(
          color: Colors.white,
          borderRadius: const BorderRadius.vertical(top: Radius.circular(24)),
          boxShadow: [
            BoxShadow(
                color: Colors.black.withValues(alpha: 0.15), blurRadius: 30)
          ],
        ),
        padding: const EdgeInsets.fromLTRB(24, 16, 24, 32),
        child: Column(mainAxisSize: MainAxisSize.min, children: [
          Container(
            width: 44,
            height: 4,
            decoration: BoxDecoration(
                color: const Color(0xFFE5E7EB),
                borderRadius: BorderRadius.circular(2)),
          ),
          const SizedBox(height: 20),
          Row(children: [
            Container(
              width: 48,
              height: 48,
              decoration: BoxDecoration(
                color: const Color(0xFF2F7BFF).withValues(alpha: 0.1),
                shape: BoxShape.circle,
              ),
              child: const Icon(Icons.bolt_rounded,
                  color: Color(0xFF2F7BFF), size: 24),
            ),
            const SizedBox(width: 14),
            Expanded(
                child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                  Text('Boost Your Fare',
                      style: GoogleFonts.poppins(
                          fontSize: 17,
                          fontWeight: FontWeight.w500,
                          color: JT.textPrimary)),
                  Text('Add extra to attract more pilots',
                      style: GoogleFonts.poppins(
                          fontSize: 12, color: const Color(0xFF6B7280))),
                ])),
          ]),
          const SizedBox(height: 22),
          Row(children: [
            _buildBoostOption(10),
            const SizedBox(width: 10),
            _buildBoostOption(20),
            const SizedBox(width: 10),
            _buildBoostOption(50),
          ]),
          const SizedBox(height: 10),
          Text('Boost amount will be added to the trip fare',
              style: GoogleFonts.poppins(
                  color: const Color(0xFF9CA3AF), fontSize: 11),
              textAlign: TextAlign.center),
        ]),
      ),
    );
  }

  Widget _buildBoostOption(int amount) {
    return Expanded(
      child: GestureDetector(
        onTap: _boostLoading
            ? null
            : () {
                Navigator.pop(context);
                _boostFare(amount);
              },
        child: Container(
          padding: const EdgeInsets.symmetric(vertical: 18),
          decoration: BoxDecoration(
            gradient: LinearGradient(
              colors: [const Color(0xFF2F7BFF), const Color(0xFF1A5FCC)],
              begin: Alignment.topLeft,
              end: Alignment.bottomRight,
            ),
            borderRadius: BorderRadius.circular(16),
            boxShadow: [
              BoxShadow(
                  color: const Color(0xFF2F7BFF).withValues(alpha: 0.3),
                  blurRadius: 12,
                  offset: const Offset(0, 4))
            ],
          ),
          child: Column(mainAxisSize: MainAxisSize.min, children: [
            const Icon(Icons.bolt_rounded, color: Colors.white, size: 20),
            const SizedBox(height: 4),
            Text('₹$amount',
                style: GoogleFonts.poppins(
                    color: Colors.white,
                    fontSize: 18,
                    fontWeight: FontWeight.w500)),
            Text('Boost',
                style:
                    GoogleFonts.poppins(color: Colors.white70, fontSize: 10)),
          ]),
        ),
      ),
    );
  }

  Future<void> _loadCancelReasons() async {
    try {
      final res = await http.get(Uri.parse(ApiConfig.configs));
      if (res.statusCode == 200) {
        final data = jsonDecode(res.body);
        final reasons = (data['cancellationReasons'] as List<dynamic>? ?? [])
            .where((r) =>
                r['userType'] == 'customer' || r['user_type'] == 'customer')
            .map((r) => r['reason']?.toString() ?? '')
            .where((r) => r.isNotEmpty)
            .toList();
        if (mounted) setState(() => _cancelReasons = reasons);
      }
    } catch (_) {}
  }

  Future<void> _pollStatus() async {
    if (!mounted) return;
    try {
      final headers = await AuthService.getHeaders();
      final res = await http
          .get(
            Uri.parse('${ApiConfig.trackTrip}/${widget.tripId}'),
            headers: headers,
          )
          .timeout(const Duration(seconds: 10));

      if (!mounted) return;

      if (res.statusCode == 200) {
        final data = jsonDecode(res.body);
        final trip = data['trip'];
        if (trip != null) {
          final rawStatus = trip['currentStatus']?.toString() ?? _status;
          final resolvedStatus =
              rawStatus == 'payment_pending' ? 'completed' : rawStatus;

          const statusRank = {
            'searching': 0,
            'driver_assigned': 1,
            'accepted': 2,
            'arrived': 3,
            'in_progress': 4,
            'on_the_way': 4,
            'completed': 5,
            'cancelled': 5,
          };

          final currentRank = statusRank[_status] ?? 0;
          final incomingRank = statusRank[resolvedStatus] ?? 0;

          if (incomingRank >= currentRank) {
            setState(() {
              // Preserve existing critical data if missing in poll
              if (_trip != null) {
                final List<String> criticalKeys = [
                  'driverName',
                  'driverPhone',
                  'driverRating',
                  'driverPhoto',
                  'driverVehicleNumber',
                  'driverVehicleModel',
                  'vehicleName',
                  'driverLat',
                  'driverLng',
                  'pickupOtp',
                  'destinationAddress',
                  'pickupAddress',
                  'pickupShortName',
                  'destinationShortName',
                  'actualFare',
                  'estimatedFare',
                  'estimatedDistance',
                  'type',
                  'tripType',
                ];
                for (var key in criticalKeys) {
                  if ((trip[key] == null || trip[key].toString().isEmpty) &&
                      (_trip![key] != null &&
                          _trip![key].toString().isNotEmpty)) {
                    trip[key] = _trip![key];
                  }
                }
              }

              final bool statusChanged = _status != resolvedStatus;
              _trip = trip;
              _status = resolvedStatus;

              if (resolvedStatus == 'completed') {
                _walletPendingAmount = double.tryParse(
                      trip['walletPendingAmount']?.toString() ??
                          trip['pendingPaymentAmount']?.toString() ??
                          '0',
                    ) ??
                    _walletPendingAmount;
              }

              if (statusChanged) {
                _handleStatusTransition(resolvedStatus);
              }
            });
          }

          final dLat = double.tryParse(trip['driverLat']?.toString() ?? '');
          final dLng = double.tryParse(trip['driverLng']?.toString() ?? '');
          final heading =
              double.tryParse(trip['driverHeading']?.toString() ?? '') ??
                  _driverHeading;
          if (dLat != null && dLng != null && dLat != 0) {
            _setDriverLocation(
              LatLng(dLat, dLng),
              heading: heading,
              animate: true,
            );
          }

          if (_status == 'completed' || _status == 'cancelled') {
            _pollTimer?.cancel();
          }
        }
      } else if (res.statusCode == 401) {
        debugPrint('[POLL] Session expired (401) during trip tracking');
        // We DON'T redirect to login here to avoid kicking out a tracking user.
        // The socket will likely still keep them updated.
      }
    } catch (e) {
      debugPrint('[POLL] Network error in status sync: $e');
    }
  }

  Future<void> _cancelTrip(String reason) async {
    // Cancel via socket first
    _socket.cancelTrip(_trip?['id']?.toString() ?? widget.tripId);
    // Also HTTP for persistence
    double? walletRefund;
    try {
      final headers = await AuthService.getHeaders();
      final res = await http.post(Uri.parse(ApiConfig.cancelTrip),
          headers: headers,
          body: jsonEncode(
              {'tripId': _trip?['id'] ?? widget.tripId, 'reason': reason}));
      if (res.statusCode == 200) {
        final data = jsonDecode(res.body);
        walletRefund = double.tryParse(data['walletRefund']?.toString() ?? '');
      }
    } catch (_) {}
    if (!mounted) return;
    if (walletRefund != null && walletRefund > 0) {
      _showStatusBanner(
          '₹${walletRefund.toStringAsFixed(0)} refunded to your wallet',
          JT.primary);
      await Future.delayed(const Duration(seconds: 2));
    }
    if (!mounted) return;
    Navigator.pushAndRemoveUntil(context,
        MaterialPageRoute(builder: (_) => const MainScreen()), (_) => false);
  }


  void _showCancelDialog() {
    final reasons = _cancelReasons.isNotEmpty
        ? _cancelReasons
        : [
            'Driver is taking too long',
            'I booked by mistake',
            'Changed travel plans',
            'Other reason',
          ];

    showModalBottomSheet(
      context: context,
      backgroundColor: Colors.white,
      shape: const RoundedRectangleBorder(
          borderRadius: BorderRadius.vertical(top: Radius.circular(24))),
      builder: (_) => Padding(
        padding: const EdgeInsets.all(24),
        child: Column(mainAxisSize: MainAxisSize.min, children: [
          Container(
              width: 40,
              height: 4,
              decoration: BoxDecoration(
                  color: JT.border, borderRadius: BorderRadius.circular(2))),
          const SizedBox(height: 20),
          Row(children: [
            Container(
                padding: const EdgeInsets.all(8),
                decoration: BoxDecoration(
                    color: JT.primary.withValues(alpha: 0.08),
                    borderRadius: BorderRadius.circular(10)),
                child: const Icon(Icons.cancel_rounded,
                    color: JT.primaryDark, size: 20)),
            const SizedBox(width: 12),
            Text('Cancel Reason',
                style: TextStyle(
                    fontSize: 15,
                    fontWeight: FontWeight.w400,
                    color: JT.textPrimary)),
          ]),
          const SizedBox(height: 16),
          ...reasons.map((r) => ListTile(
                title: Text(r,
                    style: TextStyle(
                        fontSize: 14,
                        color: JT.textSecondary,
                        fontWeight: FontWeight.w500)),
                leading: Icon(Icons.chevron_right_rounded,
                    color: Colors.grey[400], size: 18),
                contentPadding: EdgeInsets.zero,
                dense: true,
                onTap: () {
                  Navigator.pop(context);
                  _cancelTrip(r);
                },
              )),
          const SizedBox(height: 8),
        ]),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final statusInfo = _getStatusInfo(_status);
    final trip = _trip;
    final otp =
        trip?['pickupOtp']?.toString() ?? trip?['pickup_otp']?.toString();
    final driverName =
        trip?['driverName']?.toString() ?? trip?['driver_name']?.toString() ?? (_status != 'searching' ? 'Jago Pilot' : null);
    final driverPhone =
        trip?['driverPhone']?.toString() ?? trip?['driver_phone']?.toString();
    final driverRating = trip?['driverRating'] ?? trip?['driver_rating'];
    final driverPhoto =
        trip?['driverPhoto']?.toString() ?? trip?['driver_photo']?.toString();
    final actualFare = trip?['actualFare'] ?? trip?['actual_fare'];
    final estimatedFare = trip?['estimatedFare'] ?? trip?['estimated_fare'];

    final panelBg = JT.surface;

    return PopScope(
      canPop: false, // Prevent all back gestures/buttons during active tracking
      onPopInvokedWithResult: (didPop, result) {
        if (didPop) return;
        if (_status == 'completed' || _status == 'cancelled') {
          Navigator.of(context).pushAndRemoveUntil(
              MaterialPageRoute(builder: (_) => const MainScreen()),
              (_) => false);
        } else {
          // Show a hint that they can't leave
          _showStatusBanner('Active trip in progress', JT.primary);
        }
      },
      child: Scaffold(
        backgroundColor: const Color(0xFFF5F3FF),
        body: Column(
          children: [
            // Global Header
            SafeArea(
              bottom: false,
              child: Padding(
                padding: const EdgeInsets.symmetric(horizontal: 20, vertical: 10),
                child: Row(
                  mainAxisAlignment: MainAxisAlignment.spaceBetween,
                  children: [
                    GestureDetector(
                      onTap: () {
                        if (_status == 'completed' || _status == 'cancelled') {
                          Navigator.of(context).pushAndRemoveUntil(
                              MaterialPageRoute(builder: (_) => const MainScreen()),
                              (_) => false);
                        }
                      },
                      child: JT.logoBlue(height: 56),
                    ),
                    Row(
                      children: [
                        _headerAction(Icons.account_balance_wallet_outlined),
                        const SizedBox(width: 12),
                        _headerAction(Icons.notifications_none_rounded),
                      ],
                    ),
                  ],
                ),
              ),
            ),

            Expanded(
              child: Container(
                decoration: const BoxDecoration(
                  color: Colors.white,
                  borderRadius: BorderRadius.vertical(top: Radius.circular(32)),
                ),
                child: ClipRRect(
                  borderRadius: const BorderRadius.vertical(top: Radius.circular(32)),
                  child: LayoutBuilder(
                    builder: (context, constraints) {
                      final panelMaxHeight =
                          math.min(constraints.maxHeight * 0.56, 420.0);
                      final mapBottomPadding =
                          math.min(panelMaxHeight * 0.72, 260.0);
                      return Stack(children: [
                        GoogleMap(
                          initialCameraPosition:
                              CameraPosition(target: _center, zoom: 15),
                          onMapCreated: (c) {
                            _mapController = c;
                            if (_driverLatLng != null) {
                              _updateMapMarkers();
                              _fetchRouteForStatus();
                            }
                          },
                          markers: _markers,
                          polylines: _polylines,
                          circles: {
                            if (_status == 'searching' && _trip != null)
                              Circle(
                                circleId: const CircleId('search_radius'),
                                center: LatLng(
                                    double.tryParse(
                                            _trip?['pickupLat']?.toString() ??
                                                '0') ??
                                        0,
                                    double.tryParse(
                                            _trip?['pickupLng']?.toString() ??
                                                '0') ??
                                        0),
                                radius: 400,
                                fillColor: const Color(0xFF2F7BFF)
                                    .withValues(alpha: 0.05),
                                strokeColor: const Color(0xFF2F7BFF)
                                    .withValues(alpha: 0.3),
                                strokeWidth: 2,
                              ),
                          },
                          myLocationEnabled: true,
                          zoomControlsEnabled: false,
                          mapToolbarEnabled: false,
                          padding: EdgeInsets.only(bottom: mapBottomPadding),
                        ),
                        Positioned(
                          bottom: 0,
                          left: 0,
                          right: 0,
                          child: Container(
                            constraints:
                                BoxConstraints(maxHeight: panelMaxHeight),
                            decoration: BoxDecoration(
                              color: panelBg,
                              borderRadius: const BorderRadius.vertical(
                                  top: Radius.circular(28)),
                              boxShadow: const [
                                BoxShadow(
                                    color: Color(0x22000000), blurRadius: 24)
                              ],
                            ),
                            child:
                                Column(mainAxisSize: MainAxisSize.min, children: [
                              Container(
                                  width: 40,
                                  height: 4,
                                  margin:
                                      const EdgeInsets.only(top: 10, bottom: 4),
                                  decoration: BoxDecoration(
                                      color: JT.border,
                                      borderRadius: BorderRadius.circular(2))),
                              Flexible(
                                  child: SingleChildScrollView(
                                physics: const ClampingScrollPhysics(),
                                child: Padding(
                                  padding:
                                      const EdgeInsets.fromLTRB(20, 12, 20, 28),
                                  child: Column(
                                      crossAxisAlignment:
                                          CrossAxisAlignment.start,
                                      children: [
                                        _buildPremiumHeader(statusInfo, otp),
                                        const SizedBox(height: 14),
                                        if (_status != 'searching') ...[
                                          if (driverName != null)
                                            _buildPremiumDriverCard(
                                              name: driverName,
                                              rating: driverRating,
                                              photo: driverPhoto,
                                              vehicleNum:
                                                  trip?['driverVehicleNumber'] ??
                                                      '',
                                              vehicleModel:
                                                  trip?['driverVehicleModel'] ??
                                                      '',
                                              phone: driverPhone,
                                            )
                                          else
                                            const Center(
                                                child: Padding(
                                              padding: EdgeInsets.symmetric(
                                                  vertical: 20),
                                              child: CircularProgressIndicator(
                                                  strokeWidth: 2),
                                            )),
                                          const SizedBox(height: 16),
                                          if (driverName != null) ...[
                                            _buildCommunicationRow(driverName),
                                            const SizedBox(height: 16),
                                          ],
                                        ] else if (_status == 'searching') ...[
                                          _buildSearchingIndicator(
                                              statusInfo['color'] as Color),
                                          const SizedBox(height: 16),
                                        ],
                                        if (trip != null) ...[
                                          if (_status == 'in_progress' ||
                                              _status == 'on_the_way')
                                            _buildInProgressPanel(trip)
                                          else ...[
                                            _buildFareRow(
                                                trip, actualFare, estimatedFare),
                                          ],
                                        ],
                                        if (_status == 'completed') ...[
                                          const SizedBox(height: 40),
                                          const Center(
                                              child: CircularProgressIndicator(
                                                  strokeWidth: 2)),
                                          const SizedBox(height: 20),
                                          Center(
                                              child: Text('Ending your trip...',
                                                  style: GoogleFonts.poppins(
                                                      color:
                                                          JT.textSecondary))),
                                        ] else if (_status == 'cancelled') ...[
                                          const SizedBox(height: 16),
                                          _buildCancelledCard(),
                                        ] else if (_status != 'arrived' &&
                                            _status != 'in_progress' &&
                                            _status != 'on_the_way') ...[
                                          const SizedBox(height: 20),
                                          Center(
                                            child: TextButton.icon(
                                              onPressed: _showCancelDialog,
                                              icon: const Icon(
                                                  Icons.close_rounded,
                                                  size: 16,
                                                  color: Color(0xFF64748B)),
                                              label: const Text('Cancel Ride',
                                                  style: TextStyle(
                                                      color: Color(0xFF64748B),
                                                      fontSize: 13,
                                                      fontWeight:
                                                          FontWeight.w500)),
                                            ),
                                          ),
                                        ],
                                      ]),
                                ),
                              )),
                            ]),
                          ),
                        ),
                        if (_bannerMessage != null)
                          AnimatedPositioned(
                            duration: const Duration(milliseconds: 400),
                            curve: Curves.easeOutBack,
                            top: 12,
                            left: 20,
                            right: 20,
                            child: _buildTopBannerWidget(),
                          ),
                      ]);
                    },
                  ),
                ),
              ),
            ),
          ],
        ),
        bottomNavigationBar: _buildBottomNav(),
      ),
    );
  }

  void _startInAppCall(String driverName) {
    if (!_isRideSafetyCallActive(_status)) {
      _showStatusBanner('Calling is available only during an active ride.', const Color(0xFFDC2626));
      return;
    }
    final driverId =
        _trip?['driverId']?.toString() ?? _trip?['driver_id']?.toString();
    if (driverId != null && driverId.isNotEmpty) {
      Navigator.of(context).push(MaterialPageRoute(
        builder: (_) => CallScreen(
          contactName: driverName,
          tripId: widget.tripId,
          targetUserId: driverId,
        ),
      ));
    } else {
      _showStatusBanner('Driver calling is not available right now.', const Color(0xFFDC2626));
    }
  }

  void _openTripChat() {
    showModalBottomSheet(
      context: context,
      isScrollControlled: true,
      backgroundColor: Colors.transparent,
      builder: (_) => TripChatSheet(
        tripId: widget.tripId,
        senderName: 'Customer',
      ),
    );
  }

  Future<String> _getSupportPhone() async {
    try {
      final r = await http.get(Uri.parse(ApiConfig.configs));
      if (r.statusCode == 200) {
        final data = jsonDecode(r.body);
        return data['configs']?['support_phone'] ?? '+916303000000';
      }
    } catch (_) {}
    return '+916303000000';
  }

  // ── Premium UI Components ──────────────────────────────────────────────────

  Widget _buildPremiumHeader(Map<String, dynamic> statusInfo, String? otp) {
    final color = statusInfo['color'] as Color;
    final showOtp = otp != null &&
        otp.isNotEmpty &&
        (_status == 'driver_assigned' ||
            _status == 'accepted' ||
            _status == 'arrived');
    final eta = _trip?['etaMinutes']?.toString() ?? '5';

    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Row(
          mainAxisAlignment: MainAxisAlignment.spaceBetween,
          children: [
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    statusInfo['label'] as String,
                    style: GoogleFonts.poppins(
                      fontSize: 18,
                      fontWeight: FontWeight.w700,
                      color: const Color(0xFF0F172A),
                    ),
                  ),
                  if (_status != 'completed' &&
                      _status != 'cancelled' &&
                      _status != 'searching')
                    Text(
                      'Live tracking active • SECURE PIN',
                      style: GoogleFonts.poppins(
                        fontSize: 12,
                        fontWeight: FontWeight.w500,
                        color: const Color(0xFF64748B),
                      ),
                    ),
                ],
              ),
            ),
            if (_status != 'searching' &&
                _status != 'completed' &&
                _status != 'cancelled')
              IconButton(
                onPressed: _shareRide,
                icon: Container(
                  padding: const EdgeInsets.all(8),
                  decoration: BoxDecoration(
                    color: const Color(0xFFF1F5F9),
                    shape: BoxShape.circle,
                  ),
                  child: const Icon(Icons.share_rounded,
                      size: 18, color: Color(0xFF475569)),
                ),
              ),
          ],
        ),
        if (showOtp) ...[
          const SizedBox(height: 16),
          Row(
            children: [
              // PIN Card
              Expanded(
                child: Container(
                  padding:
                      const EdgeInsets.symmetric(horizontal: 16, vertical: 12),
                  decoration: BoxDecoration(
                    color: Colors.white,
                    borderRadius: BorderRadius.circular(16),
                    border: Border.all(color: const Color(0xFFE2E8F0)),
                  ),
                  child: Row(
                    children: [
                      Container(
                        padding: const EdgeInsets.all(8),
                        decoration: BoxDecoration(
                          color: const Color(0xFF6366F1).withValues(alpha: 0.1),
                          shape: BoxShape.circle,
                        ),
                        child: const Icon(Icons.stars_rounded,
                            color: Color(0xFF6366F1), size: 18),
                      ),
                      const SizedBox(width: 12),
                      Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Text('PIN',
                              style: GoogleFonts.poppins(
                                  fontSize: 11,
                                  fontWeight: FontWeight.w600,
                                  color: const Color(0xFF94A3B8))),
                          Text(otp,
                              style: GoogleFonts.poppins(
                                  fontSize: 22,
                                  fontWeight: FontWeight.w800,
                                  color: const Color(0xFF0F172A),
                                  letterSpacing: 1)),
                        ],
                      ),
                    ],
                  ),
                ),
              ),
              const SizedBox(width: 12),
              // Wait Time Card
              Expanded(
                child: Container(
                  padding:
                      const EdgeInsets.symmetric(horizontal: 16, vertical: 12),
                  decoration: BoxDecoration(
                    color: Colors.white,
                    borderRadius: BorderRadius.circular(16),
                    border: Border.all(color: const Color(0xFFE2E8F0)),
                  ),
                  child: Row(
                    children: [
                      Container(
                        padding: const EdgeInsets.all(8),
                        decoration: BoxDecoration(
                          color: const Color(0xFF10B981).withValues(alpha: 0.1),
                          shape: BoxShape.circle,
                        ),
                        child: const Icon(Icons.timer_rounded,
                            color: Color(0xFF10B981), size: 18),
                      ),
                      const SizedBox(width: 12),
                      Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Text('WAIT TIME',
                              style: GoogleFonts.poppins(
                                  fontSize: 11,
                                  fontWeight: FontWeight.w600,
                                  color: const Color(0xFF94A3B8))),
                          Text('$eta MIN',
                              style: GoogleFonts.poppins(
                                  fontSize: 20,
                                  fontWeight: FontWeight.w800,
                                  color: const Color(0xFF0F172A))),
                        ],
                      ),
                    ],
                  ),
                ),
              ),
            ],
          ),
        ],
      ],
    );
  }

  Widget _buildPremiumDriverCard({
    required String name,
    required dynamic rating,
    required String? photo,
    required String vehicleNum,
    required String vehicleModel,
    required String? phone,
  }) {
    return Container(
      padding: const EdgeInsets.all(14),
      decoration: BoxDecoration(
        color: const Color(0xFFF8FAFF),
        borderRadius: BorderRadius.circular(18),
        border: Border.all(color: JT.primary.withValues(alpha: 0.08), width: 1),
      ),
      child: Row(
        children: [
          Container(
            width: 54,
            height: 54,
            decoration: BoxDecoration(
              color: JT.border,
              shape: BoxShape.circle,
              image: photo != null && photo.isNotEmpty
                  ? DecorationImage(
                      image: NetworkImage(photo), fit: BoxFit.cover)
                  : null,
            ),
            child: (photo == null || photo.isEmpty)
                ? const Icon(Icons.person_rounded,
                    color: Colors.white, size: 30)
                : null,
          ),
          const SizedBox(width: 14),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Row(
                  children: [
                    Flexible(
                      child: Text(
                        name,
                        style: GoogleFonts.poppins(
                          fontSize: 15,
                          fontWeight: FontWeight.w500,
                          color: JT.textPrimary,
                        ),
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                      ),
                    ),
                    const SizedBox(width: 6),
                    Container(
                      padding: const EdgeInsets.symmetric(
                          horizontal: 6, vertical: 2),
                      decoration: BoxDecoration(
                        color: Colors.green[50],
                        borderRadius: BorderRadius.circular(6),
                      ),
                      child: Row(
                        mainAxisSize: MainAxisSize.min,
                        children: [
                          const Icon(Icons.star_rounded,
                              color: Colors.green, size: 12),
                          const SizedBox(width: 2),
                          Text(
                            rating?.toString() ?? '4.8',
                            style: const TextStyle(
                                fontSize: 10,
                                fontWeight: FontWeight.w600,
                                color: Colors.green),
                          ),
                        ],
                      ),
                    ),
                  ],
                ),
                const SizedBox(height: 2),
                Text(
                  vehicleModel.isNotEmpty ? vehicleModel : 'Jago Pilot',
                  style: GoogleFonts.poppins(
                      fontSize: 12, color: JT.textSecondary),
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                ),
              ],
            ),
          ),
          Column(
            crossAxisAlignment: CrossAxisAlignment.end,
            children: [
              Container(
                padding:
                    const EdgeInsets.symmetric(horizontal: 10, vertical: 4),
                decoration: BoxDecoration(
                  color: Colors.white,
                  borderRadius: BorderRadius.circular(8),
                  border: Border.all(color: JT.border, width: 1),
                ),
                child: Text(
                  vehicleNum.isNotEmpty ? vehicleNum.toUpperCase() : '...',
                  style: GoogleFonts.poppins(
                    fontSize: 12,
                    fontWeight: FontWeight.w600,
                    color: JT.textPrimary,
                    letterSpacing: 0.5,
                  ),
                ),
              ),
              const SizedBox(height: 4),
              const Text('• Verified Pilot',
                  style: TextStyle(
                      fontSize: 10,
                      color: Colors.blue,
                      fontWeight: FontWeight.w500)),
            ],
          ),
        ],
      ),
    );
  }

  Widget _buildCommunicationRow(String driverName) {
    return Row(
      children: [
        Expanded(
          child: GestureDetector(
            onTap: _openTripChat,
            child: Container(
              height: 48,
              padding: const EdgeInsets.symmetric(horizontal: 16),
              decoration: BoxDecoration(
                color: Colors.white,
                borderRadius: BorderRadius.circular(12),
                border: Border.all(color: JT.border, width: 1.2),
              ),
              child: Row(
                children: [
                  const Icon(Icons.chat_bubble_outline_rounded,
                      size: 18, color: JT.textSecondary),
                  const SizedBox(width: 10),
                  Flexible(
                    child: Text(
                      'Message $driverName...',
                      style: GoogleFonts.poppins(
                          fontSize: 13, color: JT.textSecondary),
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                    ),
                  ),
                ],
              ),
            ),
          ),
        ),
        const SizedBox(width: 12),
        if (_isRideSafetyCallActive(_status)) ...[
          GestureDetector(
            onTap: () => _startInAppCall(driverName),
            child: Container(
              width: 48,
              height: 48,
              decoration: BoxDecoration(
                color: JT.primary.withValues(alpha: 0.1),
                borderRadius: BorderRadius.circular(12),
                border: Border.all(color: JT.primary, width: 1.2),
              ),
              child: const Icon(Icons.call_rounded, color: JT.primary, size: 22),
            ),
          ),
          const SizedBox(width: 12),
        ],
        GestureDetector(
          onTap: _triggerSos,
          child: Container(
            width: 48,
            height: 48,
            decoration: BoxDecoration(
              color: const Color(0xFFDC2626).withValues(alpha: 0.1),
              borderRadius: BorderRadius.circular(12),
              border: Border.all(color: const Color(0xFFDC2626), width: 1.2),
            ),
            child: const Icon(Icons.sos_rounded,
                color: Color(0xFFDC2626), size: 22),
          ),
        ),
      ],
    );
  }

  Widget _buildSearchingIndicator(Color color) {
    return Container(
      padding: const EdgeInsets.all(20),
      decoration: BoxDecoration(
        color: color.withValues(alpha: 0.05),
        borderRadius: BorderRadius.circular(18),
        border: Border.all(color: color.withValues(alpha: 0.1), width: 1),
      ),
      child: Column(
        children: [
          _buildPulsingCircles(color),
          const SizedBox(height: 16),
          Text(
            'Finding your Pilot...',
            style: GoogleFonts.poppins(
                fontSize: 16, fontWeight: FontWeight.w600, color: color),
          ),
          const SizedBox(height: 4),
          Text(
            'Confirming nearest pilot availability',
            style: GoogleFonts.poppins(
                fontSize: 12, color: color.withValues(alpha: 0.6)),
          ),
          const SizedBox(height: 20),
          Row(
            children: [
              Expanded(
                child: ElevatedButton.icon(
                  onPressed: _showBoostFareSheet,
                  icon: const Icon(Icons.bolt_rounded, size: 16),
                  label: const Text('Boost Fare'),
                  style: ElevatedButton.styleFrom(
                    backgroundColor: JT.primary,
                    foregroundColor: Colors.white,
                    elevation: 0,
                    shape: RoundedRectangleBorder(
                        borderRadius: BorderRadius.circular(12)),
                  ),
                ),
              ),
            ],
          ),
        ],
      ),
    );
  }

  Widget _buildPulsingCircles(Color color) {
    return AnimatedBuilder(
      animation: _pulseCtrl,
      builder: (context, child) {
        final pulse = _pulseCtrl.value;
        return SizedBox(
          width: 80,
          height: 80,
          child: Stack(alignment: Alignment.center, children: [
            Opacity(
              opacity: (1 - pulse) * 0.3,
              child: Container(
                width: 40 + pulse * 40,
                height: 40 + pulse * 40,
                decoration: BoxDecoration(
                  shape: BoxShape.circle,
                  border: Border.all(color: color, width: 2),
                ),
              ),
            ),
            Container(
              width: 48,
              height: 48,
              decoration: BoxDecoration(
                shape: BoxShape.circle,
                color: color.withValues(alpha: 0.1),
              ),
              child: Icon(Icons.electric_bike_rounded, color: color, size: 24),
            ),
          ]),
        );
      },
    );
  }

  Future<void> _shareRide() async {
    final tripId = widget.tripId;
    final shareText =
        '🚗 Track my JAGO ride!\nLive location: https://jagopro.org/track/$tripId\nDownload Jago: https://jagopro.org/download';
    final encoded = Uri.encodeComponent(shareText);
    final uri = Uri.parse('whatsapp://send?text=$encoded');
    if (await canLaunchUrl(uri)) {
      await launchUrl(uri);
    } else {
      await Clipboard.setData(ClipboardData(text: shareText));
      if (mounted)
        ScaffoldMessenger.of(context).showSnackBar(const SnackBar(
            content: Text('Share text copied! Paste in WhatsApp'),
            backgroundColor: JT.primary));
    }
  }

  Future<void> _triggerSos() async {
    final confirm = await showDialog<bool>(
      context: context,
      builder: (_) => AlertDialog(
        title: const Text('🚨 SOS Alert',
            style: TextStyle(fontWeight: FontWeight.w500)),
        content: const Text(
            'Send an Emergency SOS? Our help team will contact you immediately.'),
        actions: [
          TextButton(
              onPressed: () => Navigator.pop(context, false),
              child: const Text('Cancel')),
          ElevatedButton(
              style: ElevatedButton.styleFrom(backgroundColor: JT.primary),
              onPressed: () => Navigator.pop(context, true),
              child: const Text('Send SOS',
                  style: TextStyle(
                      color: Colors.white, fontWeight: FontWeight.w500))),
        ],
      ),
    );
    if (confirm != true) return;
    final sosHeaders = await AuthService.getHeaders();
    try {
      await http.post(Uri.parse(ApiConfig.sos),
          headers: {...sosHeaders, 'Content-Type': 'application/json'},
          body: jsonEncode({
            'tripId': widget.tripId,
            'lat': _center.latitude,
            'lng': _center.longitude,
            'message': 'Customer SOS alert during trip',
          }));
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(const SnackBar(
        content: Text('🚨 SOS Alert sent! Help is on the way.',
            style: TextStyle(fontWeight: FontWeight.w400)),
        backgroundColor: JT.primary,
        behavior: SnackBarBehavior.floating,
      ));
    } catch (_) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(const SnackBar(
        content: Text('SOS failed. Call 100 immediately!',
            style: TextStyle(fontWeight: FontWeight.w400)),
        backgroundColor: JT.primaryDark,
        behavior: SnackBarBehavior.floating,
      ));
    }
  }

  Widget _buildFareRow(
      Map<String, dynamic> trip, dynamic actualFare, dynamic estimatedFare) {
    final fareVal = actualFare ?? estimatedFare;
    final dist = trip['estimatedDistance'] ?? trip['estimated_distance'];
    final vehicle = trip['vehicleName'] ?? trip['vehicle_name'];
    return Wrap(spacing: 8, children: [
      if (fareVal != null)
        _chip(
            Icons.currency_rupee_rounded, '₹$fareVal', const Color(0xFF10B981)),
      if (dist != null)
        _chip(Icons.route_rounded, '$dist km', const Color(0xFF6B7280)),
      if (vehicle != null)
        _chip(Icons.electric_bike, vehicle.toString(), const Color(0xFF6B7280)),
    ]);
  }

  Widget _chip(IconData icon, String label, Color color) {
    return Container(
      margin: const EdgeInsets.only(bottom: 4),
      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 6),
      decoration: BoxDecoration(
        color: color.withValues(alpha: 0.08),
        borderRadius: BorderRadius.circular(8),
        border: Border.all(color: color.withValues(alpha: 0.15)),
      ),
      child: Row(mainAxisSize: MainAxisSize.min, children: [
        Icon(icon, size: 13, color: color),
        const SizedBox(width: 5),
        Text(label,
            style: TextStyle(
                fontSize: 12, fontWeight: FontWeight.w500, color: color)),
      ]),
    );
  }


  Widget _buildCancelledCard() {
    return Container(
      padding: const EdgeInsets.all(20),
      decoration: BoxDecoration(
        color: const Color(0xFFFEF2F2),
        borderRadius: BorderRadius.circular(20),
        border: Border.all(color: Colors.red[100]!),
      ),
      child: Column(children: [
        const Icon(Icons.cancel_rounded, color: Colors.red, size: 48),
        const SizedBox(height: 12),
        Text('Trip Cancelled',
            style: GoogleFonts.poppins(
                fontSize: 18,
                fontWeight: FontWeight.w600,
                color: Colors.red[900])),
        const SizedBox(height: 16),
        JT.gradientButton(
            label: 'Try Again', onTap: () => Navigator.pop(context)),
      ]),
    );
  }

  Map<String, dynamic> _getStatusInfo(String status) {
    switch (status) {
      case 'searching':
        return {
          'label': 'Finding the best Pilot for you...',
          'icon': Icons.radar_rounded,
          'color': const Color(0xFF2D8CFF)
        };
      case 'driver_assigned':
      case 'accepted':
        return {
          'label': _isArriving
              ? 'Your pilot is about to arrive'
              : 'Pilot accepted your ride',
          'icon':
              _isArriving ? Icons.bolt_rounded : Icons.electric_bike_rounded,
          'color': const Color(0xFF2D8CFF)
        };
      case 'arrived':
        return {
          'label': 'Your pilot is arrived',
          'icon': Icons.location_on_rounded,
          'color': const Color(0xFF10B981)
        };
      case 'in_progress':
      case 'on_the_way':
        return {
          'label': 'Your ride is started',
          'icon': Icons.auto_awesome_rounded,
          'color': const Color(0xFF2D8CFF)
        };
      case 'completed':
        return {
          'label': 'Your ride is ended',
          'icon': Icons.check_circle_rounded,
          'color': JT.primary
        };
      case 'cancelled':
        return {
          'label': 'Trip Cancelled',
          'icon': Icons.cancel_rounded,
          'color': JT.primaryDark
        };
      default:
        return {
          'label': 'Loading...',
          'icon': Icons.hourglass_empty_rounded,
          'color': const Color(0xFF94A3B8)
        };
    }
  }

  void _animateToDestination() {
    Future.delayed(const Duration(milliseconds: 300), () {
      try {
        if (!mounted || _trip == null) return;
        final dLatStr = _trip?['destinationLat']?.toString() ??
            _trip?['destination_lat']?.toString() ??
            '';
        final dLngStr = _trip?['destinationLng']?.toString() ??
            _trip?['destination_lng']?.toString() ??
            '';

        final dLat = double.tryParse(dLatStr);
        final dLng = double.tryParse(dLngStr);

        if (dLat != null &&
            dLng != null &&
            dLat != 0 &&
            dLng != 0 &&
            _mapController != null) {
          debugPrint('[MAP] Animating to destination: $dLat, $dLng');
          _mapController!
              .animateCamera(CameraUpdate.newLatLngZoom(LatLng(dLat, dLng), 15))
              .catchError((e) {
            debugPrint('[MAP] Camera animation failed: $e');
          });
        }
      } catch (e) {
        debugPrint('[MAP] Error in _animateToDestination: $e');
      }
    });
  }

  void _showStatusBanner(String message, Color color) {
    if (!mounted) return;

    // Cancel existing timer if any
    _bannerTimer?.cancel();

    setState(() {
      _bannerMessage = message;
      _bannerColor = color;
    });

    // Auto-hide after 4 seconds
    _bannerTimer = Timer(const Duration(seconds: 4), () {
      if (mounted) {
        setState(() => _bannerMessage = null);
      }
    });
  }

  Widget _buildTopBannerWidget() {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 18, vertical: 14),
      decoration: BoxDecoration(
        color: _bannerColor,
        borderRadius: BorderRadius.circular(16),
        boxShadow: [
          BoxShadow(
            color: _bannerColor.withValues(alpha: 0.3),
            blurRadius: 15,
            offset: const Offset(0, 8),
          ),
        ],
      ),
      child: Row(
        children: [
          Container(
            padding: const EdgeInsets.all(6),
            decoration: BoxDecoration(
              color: Colors.white.withValues(alpha: 0.2),
              shape: BoxShape.circle,
            ),
            child:
                const Icon(Icons.stars_rounded, color: Colors.white, size: 20),
          ),
          const SizedBox(width: 14),
          Expanded(
            child: Text(
              _bannerMessage!,
              style: GoogleFonts.poppins(
                color: Colors.white,
                fontWeight: FontWeight.w600,
                fontSize: 14,
                letterSpacing: 0.2,
              ),
            ),
          ),
          GestureDetector(
            onTap: () => setState(() => _bannerMessage = null),
            child: Icon(Icons.close_rounded,
                color: Colors.white.withValues(alpha: 0.7), size: 18),
          ),
        ],
      ),
    );
  }

  void _showArrivalBanner() {
    _showStatusBanner('Your pilot is arrived', const Color(0xFF10B981));
  }

  Widget _buildInProgressPanel(Map<String, dynamic> trip) {
    final dest = trip['destinationShortName'] ??
        trip['destinationAddress'] ??
        'Destination';
    final dist = trip['estimatedDistance'] ?? trip['estimated_distance'];

    return Container(
      padding: const EdgeInsets.all(16),
      decoration: BoxDecoration(
        color: const Color(0xFFF8FAFF),
        borderRadius: BorderRadius.circular(20),
        border: Border.all(color: Colors.blue.withValues(alpha: 0.1)),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Container(
                padding: const EdgeInsets.all(10),
                decoration: BoxDecoration(
                    color: Colors.blue.withValues(alpha: 0.12),
                    shape: BoxShape.circle),
                child: const Icon(Icons.navigation_rounded,
                    color: Colors.blue, size: 20),
              ),
              const SizedBox(width: 14),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text('Heading to',
                        style: GoogleFonts.poppins(
                            fontSize: 12, color: JT.textSecondary)),
                    Text(dest,
                        style: GoogleFonts.poppins(
                            fontSize: 15,
                            fontWeight: FontWeight.w600,
                            color: JT.textPrimary),
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis),
                  ],
                ),
              ),
              if (dist != null)
                Container(
                  padding:
                      const EdgeInsets.symmetric(horizontal: 10, vertical: 6),
                  decoration: BoxDecoration(
                      color: Colors.white,
                      borderRadius: BorderRadius.circular(10),
                      border: Border.all(color: JT.border)),
                  child: Text('$dist km',
                      style: GoogleFonts.poppins(
                          fontSize: 13,
                          fontWeight: FontWeight.w700,
                          color: JT.primary)),
                ),
            ],
          ),
          const SizedBox(height: 16),
          const Divider(height: 1),
          const SizedBox(height: 16),
          Row(
            mainAxisAlignment: MainAxisAlignment.spaceBetween,
            children: [
              Row(
                children: [
                  _buildLiveDot(),
                  const SizedBox(width: 8),
                  Text('Trip is in progress',
                      style: GoogleFonts.poppins(
                          fontSize: 12,
                          color: Colors.green,
                          fontWeight: FontWeight.w600)),
                ],
              ),
              const Icon(Icons.security_rounded, color: Colors.blue, size: 18),
            ],
          ),
        ],
      ),
    );
  }

  Widget _buildLiveDot() {
    return Container(
      width: 8,
      height: 8,
      decoration:
          const BoxDecoration(color: Colors.red, shape: BoxShape.circle),
    );
  }

  Widget _headerAction(IconData icon) {
    return GestureDetector(
      onTap: () {
        if (_status == 'completed' || _status == 'cancelled') {
          Navigator.of(context).pushAndRemoveUntil(
              MaterialPageRoute(builder: (_) => const MainScreen()),
              (_) => false);
        } else {
          _showStatusBanner('Active trip in progress', JT.primary);
        }
      },
      child: Container(
        width: 48,
        height: 48,
        decoration: BoxDecoration(
          color: Colors.white,
          borderRadius: BorderRadius.circular(16),
          boxShadow: [
            BoxShadow(color: Colors.black.withValues(alpha: 0.04), blurRadius: 10, offset: const Offset(0, 4)),
          ],
        ),
        child: Icon(icon, color: const Color(0xFF64748B), size: 24),
      ),
    );
  }

  Widget _buildBottomNav() {
    return Container(
      decoration: BoxDecoration(
        color: Colors.white,
        border: Border(top: BorderSide(color: Colors.grey.shade100, width: 1)),
      ),
      child: SafeArea(
        top: false,
        child: Padding(
          padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 12),
          child: Row(
            mainAxisAlignment: MainAxisAlignment.spaceBetween,
            children: [
              _navItem(0, Icons.home_rounded, Icons.home_outlined, 'Home'),
              _navItem(1, Icons.receipt_long_rounded, Icons.receipt_long_outlined, 'Trips'),
              _navItem(2, Icons.account_balance_wallet_rounded, Icons.account_balance_wallet_outlined, 'Wallet'),
              _navItem(3, Icons.person_rounded, Icons.person_outline_rounded, 'Profile'),
            ],
          ),
        ),
      ),
    );
  }

  Widget _navItem(int index, IconData activeIcon, IconData inactiveIcon, String label) {
    bool isSelected = index == 0;
    return GestureDetector(
      onTap: () {
        if (_status == 'completed' || _status == 'cancelled') {
          Navigator.of(context).pushAndRemoveUntil(
              MaterialPageRoute(builder: (_) => const MainScreen()),
              (_) => false);
        } else {
          _showStatusBanner('Active trip in progress', JT.primary);
        }
      },
      child: AnimatedContainer(
        duration: const Duration(milliseconds: 300),
        padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 10),
        decoration: isSelected
            ? BoxDecoration(
                gradient: const LinearGradient(
                  colors: [Color(0xFF7C3AED), Color(0xFF6366F1)], 
                  begin: Alignment.topLeft,
                  end: Alignment.bottomRight,
                ),
                borderRadius: BorderRadius.circular(20),
                boxShadow: [
                  BoxShadow(color: const Color(0xFF7C3AED).withValues(alpha: 0.3), blurRadius: 10, offset: const Offset(0, 4)),
                ],
              )
            : null,
        child: Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            Icon(
              isSelected ? activeIcon : inactiveIcon,
              color: isSelected ? Colors.white : const Color(0xFF94A3B8),
              size: 22,
            ),
            if (isSelected) ...[
              const SizedBox(width: 8),
              Text(
                label,
                style: GoogleFonts.poppins(color: Colors.white, fontSize: 13, fontWeight: FontWeight.w600),
              ),
            ]
          ],
        ),
      ),
    );
  }
}
