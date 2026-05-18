import 'dart:async';
import 'dart:convert';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:geolocator/geolocator.dart';
import 'package:google_fonts/google_fonts.dart';
import 'package:google_maps_flutter/google_maps_flutter.dart';
import 'package:http/http.dart' as http;
import 'package:image_picker/image_picker.dart';
import '../../config/api_config.dart';
import '../../config/jago_theme.dart';
import '../../services/auth_service.dart';
import '../../services/navigation_service.dart';
import '../../services/socket_service.dart';
import '../../services/call_service.dart';
import '../call/call_screen.dart';
import '../chat/trip_chat_sheet.dart';
import '../home/home_screen.dart';

// Quick polyline decoder (no extra package needed)
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

// ─────────────────────────────────────────────────────────────────────────────

class TripScreen extends StatefulWidget {
  final Map<String, dynamic>? trip;
  const TripScreen({super.key, this.trip});
  @override
  State<TripScreen> createState() => _TripScreenState();
}

class _TripScreenState extends State<TripScreen>
    with TickerProviderStateMixin, WidgetsBindingObserver {
  final SocketService _socket = SocketService();
  GoogleMapController? _mapController;
  LatLng _center = const LatLng(17.3850, 78.4867);
  String _status = 'accepted';
  Map<String, dynamic>? _trip;
  bool _loading = false;
  bool _nearPickup = false;
  final _otpCtrl = TextEditingController();
  Timer? _locationTimer;
  StreamSubscription<Position>? _posStream;
  Position? _lastTripPosition;
  Timer? _tripTimer;
  Timer? _statePollTimer; // 5s poll — server is source of truth
  List<String> _cancelReasons = [];
  StreamSubscription? _cancelSub;
  StreamSubscription? _tripStatusSub;
  StreamSubscription? _incomingCallSub;
  bool _locationWarningShown = false;
  bool _hasLiveLocationAccess = false;
  bool _autoFollowDriver = true;
  final Set<Marker> _markers = {};
  final Set<Polyline> _polylines = {};
  final NavigationService _navigation = NavigationService.instance;

  // Live stats
  double _distanceToTargetM = 0;
  int _etaSec = 0;
  int _tripElapsedSec = 0;
  DateTime? _tripStartTime;
  List<NavigationStepModel> _navSteps = const [];
  int _navStepIndex = 0;
  String _navInstruction = 'Follow the highlighted route';
  String _navSecondaryInstruction = 'Navigation guidance will appear here';
  bool _navMuted = false;
  bool _isRerouting = false;
  bool _isOffRoute = false;
  int _offRouteHits = 0;
  DateTime? _lastRerouteAt;

  // Animation for status pill
  late AnimationController _pulseCtrl;

  String _shortLocation(String v) {
    final s = v.trim();
    if (s.isEmpty) return s;
    return s.split(',').first.trim();
  }

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    _pulseCtrl = AnimationController(
        vsync: this, duration: const Duration(milliseconds: 1200))
      ..repeat(reverse: true);
    _navigation.init();
    _socket.connect(ApiConfig.socketUrl);
    _trip = widget.trip;
    if (_trip != null) {
      _status = _trip!['currentStatus'] ?? _trip!['status'] ?? 'accepted';
      // Register active trip so socket can rejoin room on reconnect
      final tripId = _trip!['tripId'] ?? _trip!['id'];
      if (tripId != null) _socket.setActiveTrip(tripId.toString());
      final lat = double.tryParse(_trip!['pickupLat']?.toString() ?? '');
      final lng = double.tryParse(_trip!['pickupLng']?.toString() ?? '');
      if (lat != null && lng != null && lat != 0) _center = LatLng(lat, lng);
    }
    _startLocationUpdates();
    _startStatePoll();
    _loadCancelReasons();
    _listenForCancel();
    _listenForTripStatus();
    CallService().init();
    _listenForIncomingCalls();
    WidgetsBinding.instance.addPostFrameCallback((_) {
      _initMapMarkers();
      _fetchRouteForCurrentStatus();
      if (_status == 'in_progress' || _status == 'on_the_way') {
        _startTripTimer();
      }
      _validateActiveTrip();
    });
    print(
        '[TRIP] Screen init — tripId=${_trip?['tripId'] ?? _trip?['id']} status=$_status');
  }

  // ── Validate trip still active on screen load ─────────────────────────────

  Future<void> _validateActiveTrip() async {
    final tripId = _trip?['tripId'] ?? _trip?['id'];
    if (tripId == null) return;
    try {
      final headers = await AuthService.getHeaders();
      final res = await http.get(Uri.parse(ApiConfig.driverActiveTrip),
          headers: headers);
      if (!mounted) return;
      if (res.statusCode == 200) {
        final data = jsonDecode(res.body);
        final serverTrip = data['trip'];
        if (serverTrip == null) {
          // No active trip on server — this screen is stale
          ScaffoldMessenger.of(context).showSnackBar(
            const SnackBar(
                content: Text('Trip no longer active. Returning home.'),
                backgroundColor: Colors.orange),
          );
          Navigator.pushAndRemoveUntil(
              context,
              MaterialPageRoute(builder: (_) => const HomeScreen()),
              (_) => false);
        }
      }
    } catch (_) {
      // Network error — keep screen, socket cancel handler will catch real cancels
    }
  }

  // ── State polling — server is source of truth ────────────────────────────

  void _startStatePoll() {
    _statePollTimer?.cancel();
    _statePollTimer =
        Timer.periodic(const Duration(seconds: 5), (_) => _syncTripState());
  }

  void _stopStatePoll() {
    _statePollTimer?.cancel();
    _statePollTimer = null;
  }

  Future<void> _syncTripState() async {
    if (!mounted) return;
    final tripId = _trip?['tripId'] ?? _trip?['id'];
    if (tripId == null) return;
    try {
      final headers = await AuthService.getHeaders();
      final res = await http
          .get(Uri.parse(ApiConfig.driverActiveTrip), headers: headers)
          .timeout(const Duration(seconds: 4));
      if (!mounted) return;
      if (res.statusCode == 200) {
        final data = jsonDecode(res.body) as Map<String, dynamic>;
        final serverTrip = data['trip'] as Map<String, dynamic>?;
        if (serverTrip == null) {
          // Trip ended on server — pop to home
          _stopStatePoll();
          if (mounted) {
            Navigator.pushAndRemoveUntil(
                context,
                MaterialPageRoute(builder: (_) => const HomeScreen()),
                (_) => false);
          }
          return;
        }
        final serverStatus =
            (serverTrip['currentStatus'] ?? serverTrip['current_status'] ?? '')
                .toString();
        if (serverStatus == 'completed' || serverStatus == 'cancelled') {
          _stopStatePoll();
          if (mounted) {
            Navigator.pushAndRemoveUntil(
                context,
                MaterialPageRoute(builder: (_) => const HomeScreen()),
                (_) => false);
          }
          return;
        }
        // Sync status if server differs from local (handles race conditions)
        final mergedTrip = _mergeTripData(_trip, serverTrip);
        final shouldUpdateTrip =
            jsonEncode(mergedTrip) != jsonEncode(_trip ?? const {});
        if ((serverStatus.isNotEmpty && serverStatus != _status) ||
            shouldUpdateTrip) {
          final previousStatus = _status;
          setState(() {
            _status = serverStatus.isNotEmpty ? serverStatus : _status;
            _trip = mergedTrip;
          });
          _initMapMarkers();
          _fetchRouteForCurrentStatus();
          if ((serverStatus == 'in_progress' || serverStatus == 'on_the_way') &&
              previousStatus != 'in_progress' &&
              previousStatus != 'on_the_way') {
            _startTripTimer();
          }
          print('[TRIP] Poll sync: $previousStatus → $serverStatus');
        }
      }
    } catch (_) {} // network error — keep polling
  }

  // ── Timers ────────────────────────────────────────────────────────────────

  void _startTripTimer() {
    _tripStartTime ??= DateTime.now();
    _tripTimer?.cancel();
    _tripTimer = Timer.periodic(const Duration(seconds: 1), (_) {
      if (!mounted) return;
      setState(() {
        _tripElapsedSec = DateTime.now().difference(_tripStartTime!).inSeconds;
      });
    });
  }

  void _stopTripTimer() {
    _tripTimer?.cancel();
    _tripTimer = null;
  }

  String _formatElapsed(int secs) {
    final m = (secs ~/ 60).toString().padLeft(2, '0');
    final s = (secs % 60).toString().padLeft(2, '0');
    return '$m:$s';
  }

  String _formatEta(int secs) {
    if (secs <= 0) return '--';
    if (secs < 60) return '< 1 min';
    final mins = (secs / 60).ceil();
    if (mins < 60) return '$mins min';
    return '${(mins / 60).floor()}h ${mins % 60}m';
  }

  String _formatDist(double m) {
    if (m <= 0) return '--';
    if (m < 1000) return '${m.round()} m';
    return '${(m / 1000).toStringAsFixed(1)} km';
  }

  // ── Socket listeners ──────────────────────────────────────────────────────

  void _listenForCancel() {
    _cancelSub = _socket.onTripCancelled.listen((data) {
      if (!mounted) return;
      _locationTimer?.cancel();
      _stopTripTimer();
      showDialog(
        context: context,
        barrierDismissible: false,
        builder: (_) => AlertDialog(
          backgroundColor: JT.surface,
          shape:
              RoundedRectangleBorder(borderRadius: BorderRadius.circular(20)),
          title: Text('Trip Cancelled',
              style: GoogleFonts.poppins(
                  color: JT.textPrimary, fontWeight: FontWeight.w400)),
          content: Text('Customer cancelled the trip.',
              style:
                  GoogleFonts.poppins(color: JT.textSecondary, fontSize: 14)),
          actions: [
            ElevatedButton(
              style: ElevatedButton.styleFrom(
                  backgroundColor: JT.primary,
                  foregroundColor: Colors.white,
                  shape: RoundedRectangleBorder(
                      borderRadius: BorderRadius.circular(10))),
              onPressed: () {
                Navigator.pop(context);
                Navigator.pushAndRemoveUntil(
                    context,
                    MaterialPageRoute(builder: (_) => const HomeScreen()),
                    (_) => false);
              },
              child: const Text('OK',
                  style: TextStyle(fontWeight: FontWeight.w500)),
            ),
          ],
        ),
      );
    });
  }

  void _listenForIncomingCalls() {
    _incomingCallSub = _socket.onCallIncoming.listen((data) {
      if (!mounted) return;
      final callerName = data['callerName']?.toString() ?? 'Customer';
      final callerId = data['callerId']?.toString() ?? '';
      final tripId =
          data['tripId']?.toString() ?? (_trip?['id']?.toString() ?? '');
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

  void _listenForTripStatus() {
    _tripStatusSub = _socket.onTripStatus.listen((data) {
      if (!mounted) return;
      final incomingTripId =
          data['tripId']?.toString() ?? data['id']?.toString() ?? '';
      final activeTripId =
          _trip?['id']?.toString() ?? _trip?['tripId']?.toString() ?? '';
      if (incomingTripId.isNotEmpty &&
          activeTripId.isNotEmpty &&
          incomingTripId != activeTripId) {
        return;
      }

      final mergedTrip = _mergeTripData(_trip, Map<String, dynamic>.from(data));
      final nextStatus = (mergedTrip['currentStatus'] ??
              mergedTrip['current_status'] ??
              mergedTrip['status'] ??
              _status)
          .toString();
      final statusChanged = nextStatus != _status;

      setState(() {
        _trip = mergedTrip;
        _status = nextStatus;
      });
      _initMapMarkers();
      _fetchRouteForCurrentStatus();
      if (statusChanged &&
          (nextStatus == 'in_progress' || nextStatus == 'on_the_way')) {
        _startTripTimer();
      }
    });
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    _otpCtrl.dispose();
    _locationTimer?.cancel();
    _posStream?.cancel();
    _stopTripTimer();
    _stopStatePoll();
    _cancelSub?.cancel();
    _tripStatusSub?.cancel();
    _incomingCallSub?.cancel();
    _pulseCtrl.dispose();
    super.dispose();
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state == AppLifecycleState.resumed) {
      if (!_socket.isConnected) {
        _socket.connect(ApiConfig.socketUrl);
      }
      final tid = _trip?['id']?.toString() ?? _trip?['tripId']?.toString();
      if (tid != null) {
        _socket.setActiveTrip(tid);
      }
      _syncTripState();
    }
  }

  // ── Map & Route ───────────────────────────────────────────────────────────

  void _initMapMarkers() {
    if (!mounted || _trip == null) return;
    final pLat = double.tryParse(_trip!['pickupLat']?.toString() ??
        _trip!['pickup_lat']?.toString() ??
        '');
    final pLng = double.tryParse(_trip!['pickupLng']?.toString() ??
        _trip!['pickup_lng']?.toString() ??
        '');
    final dLat = double.tryParse(_trip!['destinationLat']?.toString() ??
        _trip!['destination_lat']?.toString() ??
        '');
    final dLng = double.tryParse(_trip!['destinationLng']?.toString() ??
        _trip!['destination_lng']?.toString() ??
        '');
    setState(() {
      _markers.clear();
      if (pLat != null && pLat != 0 && pLng != null) {
        _markers.add(Marker(
          markerId: const MarkerId('pickup'),
          position: LatLng(pLat, pLng),
          icon:
              BitmapDescriptor.defaultMarkerWithHue(BitmapDescriptor.hueGreen),
          infoWindow: InfoWindow(
            title: 'Pickup',
            snippet: _shortLocation(
                (_trip!['pickupShortName'] ?? _trip!['pickupAddress'] ?? '')
                    .toString()),
          ),
        ));
      }
      if (dLat != null && dLat != 0 && dLng != null) {
        _markers.add(Marker(
          markerId: const MarkerId('destination'),
          position: LatLng(dLat, dLng),
          icon: BitmapDescriptor.defaultMarkerWithHue(BitmapDescriptor.hueRed),
          infoWindow: InfoWindow(
            title: 'Drop',
            snippet: _shortLocation((_trip!['destinationShortName'] ??
                    _trip!['destinationAddress'] ??
                    '')
                .toString()),
          ),
        ));
      }
    });
  }

  Map<String, dynamic> _mergeTripData(
      Map<String, dynamic>? previous, Map<String, dynamic>? next) {
    final merged = <String, dynamic>{...?previous};
    if (next == null) return merged;

    next.forEach((key, value) {
      final lower = key.toLowerCase();
      final isCoord = lower.contains('lat') || lower.contains('lng');
      if (isCoord && (value == null || value.toString().trim().isEmpty)) {
        return;
      }
      merged[key] = value;
    });

    for (final criticalKey in [
      'id',
      'tripId',
      'pickupLat',
      'pickupLng',
      'pickup_lat',
      'pickup_lng',
      'destinationLat',
      'destinationLng',
      'destination_lat',
      'destination_lng',
      'customerId',
      'customer_id',
    ]) {
      merged[criticalKey] ??= previous?[criticalKey];
    }
    return merged;
  }

  bool get _isHeadingToPickup =>
      _status == 'accepted' ||
      _status == 'driver_assigned';

  LatLng? _currentTargetLatLng() {
    final trip = _trip;
    if (trip == null) return null;
    final lat = _isHeadingToPickup
        ? double.tryParse(
                trip['pickupLat']?.toString() ?? trip['pickup_lat']?.toString() ?? '')
            ?? 0.0
        : double.tryParse(trip['destinationLat']?.toString() ??
                trip['destination_lat']?.toString() ??
                '')
            ?? 0.0;
    final lng = _isHeadingToPickup
        ? double.tryParse(
                trip['pickupLng']?.toString() ?? trip['pickup_lng']?.toString() ?? '')
            ?? 0.0
        : double.tryParse(trip['destinationLng']?.toString() ??
                trip['destination_lng']?.toString() ??
                '')
            ?? 0.0;
    if (lat == 0.0 || lng == 0.0) return null;
    if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return null;
    return LatLng(lat, lng);
  }

  String _currentTargetLabel() {
    final trip = _trip;
    if (trip == null) return 'route';
    return _shortLocation((_isHeadingToPickup
            ? trip['pickupShortName'] ??
                trip['pickupAddress'] ??
                trip['pickup_address'] ??
                'Pickup'
            : trip['destinationShortName'] ??
                trip['destinationAddress'] ??
                trip['destination_address'] ??
                'Destination')
        .toString());
  }

  Future<void> _focusMapOnRoute({bool includeDriver = true}) async {
    if (_mapController == null) return;
    final points = <LatLng>[];
    if (includeDriver && _lastTripPosition != null) {
      points.add(LatLng(
          _lastTripPosition!.latitude, _lastTripPosition!.longitude));
    }
    final target = _currentTargetLatLng();
    if (target != null) points.add(target);

    final routePoints = _polylines
        .where((line) => line.polylineId.value == 'route')
        .expand((line) => line.points)
        .toList();
    if (routePoints.isNotEmpty) {
      points.addAll(routePoints);
    }
    if (points.isEmpty) return;

    double minLat = points.first.latitude;
    double maxLat = points.first.latitude;
    double minLng = points.first.longitude;
    double maxLng = points.first.longitude;

    for (final point in points.skip(1)) {
      if (point.latitude < minLat) minLat = point.latitude;
      if (point.latitude > maxLat) maxLat = point.latitude;
      if (point.longitude < minLng) minLng = point.longitude;
      if (point.longitude > maxLng) maxLng = point.longitude;
    }

    if ((maxLat - minLat).abs() < 0.0005 && (maxLng - minLng).abs() < 0.0005) {
      await _mapController!.animateCamera(
        CameraUpdate.newCameraPosition(
          CameraPosition(target: points.first, zoom: 17),
        ),
      );
      return;
    }

    await _mapController!.animateCamera(CameraUpdate.newLatLngBounds(
      LatLngBounds(
        southwest: LatLng(minLat, minLng),
        northeast: LatLng(maxLat, maxLng),
      ),
      72,
    ));
  }

  Future<void> _updateNavigationProgress() async {
    final pos = _lastTripPosition;
    if (pos == null) return;
    final progress = _navigation.computeProgress(
      steps: _navSteps,
      currentLat: pos.latitude,
      currentLng: pos.longitude,
      fallbackRemainingDistanceMeters: _distanceToTargetM.round(),
      fallbackRemainingDurationSeconds: _etaSec,
    );
    if (!mounted) return;
    setState(() {
      _navStepIndex = progress.stepIndex;
      _distanceToTargetM = progress.remainingDistanceMeters.toDouble();
      _etaSec = progress.remainingDurationSeconds;
      _navInstruction =
          progress.activeStep?.instruction.isNotEmpty == true
              ? progress.activeStep!.instruction
              : (_isHeadingToPickup
                  ? 'Head to pickup'
                  : 'Head to destination');
      _navSecondaryInstruction =
          progress.activeStep?.roadName.isNotEmpty == true
              ? progress.activeStep!.roadName
              : 'Stay on the highlighted route';
    });
    await _navigation.announceStep(progress, muted: _navMuted);
  }

  double _distanceFromRouteMeters(double lat, double lng) {
    final routePoints = _polylines
        .where((line) => line.polylineId.value == 'route')
        .expand((line) => line.points)
        .toList();
    if (routePoints.isEmpty) return 0;

    double minDistance = double.infinity;
    for (final point in routePoints) {
      final distance = Geolocator.distanceBetween(
        lat,
        lng,
        point.latitude,
        point.longitude,
      );
      if (distance < minDistance) minDistance = distance;
    }
    return minDistance == double.infinity ? 0 : minDistance;
  }

  Future<void> _maybeHandleOffRoute(double lat, double lng) async {
    if (_isRerouting) return;
    final routeDistance = _distanceFromRouteMeters(lat, lng);
    if (routeDistance <= 0) return;

    final now = DateTime.now();
    if (routeDistance > 120) {
      _offRouteHits += 1;
      if (mounted && !_isOffRoute) {
        setState(() {
          _isOffRoute = true;
          _navSecondaryInstruction = 'Driver is off route by ${routeDistance.round()} m';
        });
      }
      final rerouteCoolingDown = _lastRerouteAt != null &&
          now.difference(_lastRerouteAt!) < const Duration(seconds: 12);
      if (_offRouteHits >= 2 && !rerouteCoolingDown) {
        _lastRerouteAt = now;
        if (mounted) {
          setState(() {
            _isRerouting = true;
            _navInstruction = 'Finding a better route';
            _navSecondaryInstruction = 'Rerouting from your live position';
          });
        }
        await _fetchRouteForCurrentStatus();
        if (!mounted) return;
        setState(() {
          _isRerouting = false;
          _isOffRoute = false;
          _offRouteHits = 0;
        });
      }
      return;
    }

    if (_offRouteHits != 0 || _isOffRoute) {
      if (mounted) {
        setState(() {
          _offRouteHits = 0;
          _isOffRoute = false;
        });
      } else {
        _offRouteHits = 0;
        _isOffRoute = false;
      }
    }
  }

  void _updateSelfMarker(double lat, double lng) {
    if (!mounted) return;
    setState(() {
      _markers.removeWhere((m) => m.markerId.value == 'self');
      _markers.add(Marker(
        markerId: const MarkerId('self'),
        position: LatLng(lat, lng),
        icon: BitmapDescriptor.defaultMarkerWithHue(BitmapDescriptor.hueAzure),
        infoWindow: const InfoWindow(title: 'You'),
        zIndexInt: 2,
      ));
    });
  }

  Future<void> _showLocationPrompt({
    required String title,
    required String message,
    required Future<bool> Function() openSettings,
  }) async {
    if (!mounted || _locationWarningShown) return;
    _locationWarningShown = true;
    await showDialog(
      context: context,
      barrierDismissible: false,
      builder: (_) => AlertDialog(
        title: Text(title),
        content: Text(message),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(context),
            child: const Text('Cancel'),
          ),
          ElevatedButton(
            onPressed: () async {
              Navigator.pop(context);
              await openSettings();
            },
            child: const Text('Open Settings'),
          ),
        ],
      ),
    );
  }

  Future<Position?> _resolveTripLocation() async {
    Position? fallback;
    try {
      fallback = await Geolocator.getLastKnownPosition();
    } catch (_) {}

    final serviceEnabled = await Geolocator.isLocationServiceEnabled();
    if (!serviceEnabled) {
      _hasLiveLocationAccess = false;
      if (fallback != null) return fallback;
      await _showLocationPrompt(
        title: 'Location Services Off',
        message:
            'Turn on device location so the customer can see your live trip movement.',
        openSettings: Geolocator.openLocationSettings,
      );
      return null;
    }

    var permission = await Geolocator.checkPermission();
    if (permission == LocationPermission.denied) {
      permission = await Geolocator.requestPermission();
    }
    if (permission == LocationPermission.denied ||
        permission == LocationPermission.deniedForever) {
      _hasLiveLocationAccess = false;
      if (fallback != null) return fallback;
      await _showLocationPrompt(
        title: 'Location Required',
        message:
            'Location access is required during trips so the customer can track you live.',
        openSettings: Geolocator.openAppSettings,
      );
      return null;
    }
    _hasLiveLocationAccess = true;

    try {
      return await Geolocator.getCurrentPosition(
        locationSettings: const LocationSettings(
          accuracy: LocationAccuracy.high,
          timeLimit: Duration(seconds: 10),
        ),
      );
    } catch (_) {
      return fallback;
    }
  }

  Future<void> _fetchRouteForCurrentStatus() async {
    final t = _trip;
    if (t == null) return;
    // Use best available GPS origin: prefer real GPS > last cached > map center
    final origin = _lastTripPosition;
    final myLat = origin?.latitude ?? _center.latitude;
    final myLng = origin?.longitude ?? _center.longitude;

    final toPickup = _isHeadingToPickup;

    double destLat, destLng;
    if (toPickup) {
      destLat = double.tryParse(t['pickupLat']?.toString() ??
              t['pickup_lat']?.toString() ??
              '') ??
          0;
      destLng = double.tryParse(t['pickupLng']?.toString() ??
              t['pickup_lng']?.toString() ??
              '') ??
          0;
    } else {
      destLat = double.tryParse(t['destinationLat']?.toString() ??
              t['destination_lat']?.toString() ??
              '') ??
          0;
      destLng = double.tryParse(t['destinationLng']?.toString() ??
              t['destination_lng']?.toString() ??
              '') ??
          0;
    }
    if (destLat == 0 || destLng == 0) {
      print('[ROUTE] Skipping fetch — no valid destination coords (status=$_status)');
      return;
    }
    print('[ROUTE] Fetching route from ($myLat,$myLng) → ($destLat,$destLng) [status=$_status]');
    await _fetchRoute(myLat, myLng, destLat, destLng);
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
        final distKm = (data['totalDistanceKm'] as num?)?.toDouble() ?? 0.0;
        final durMin =
            (data['totalDurationMinutes'] as num?)?.toDouble() ?? 0.0;
        final navSteps = _navigation.parseSteps(data['steps']);
        if (overviewPolyline != null && mounted) {
          final pts = _decodePolyline(overviewPolyline);
          setState(() {
            _polylines.clear();
            _polylines.add(Polyline(
              polylineId: const PolylineId('route'),
              points: pts,
              color: JT.primary,
              width: 5,
              patterns: [],
            ));
            _distanceToTargetM = distKm * 1000;
            _etaSec = (durMin * 60).round();
            _navSteps = navSteps;
            _navStepIndex = 0;
            _isRerouting = false;
            _isOffRoute = false;
            _offRouteHits = 0;
            if (navSteps.isNotEmpty) {
              _navInstruction = navSteps.first.instruction;
              _navSecondaryInstruction = navSteps.first.roadName.isNotEmpty
                  ? navSteps.first.roadName
                  : 'Stay on the highlighted route';
            } else {
              _navInstruction = _isHeadingToPickup
                  ? 'Head to pickup'
                  : 'Head to destination';
              _navSecondaryInstruction = 'Stay on the highlighted route';
            }
          });
          await _updateNavigationProgress();
          await _focusMapOnRoute();
        }
      }
    } catch (_) {}
  }

  // ── Location updates ──────────────────────────────────────────────────────

  Future<void> _startLocationUpdates() async {
    _locationTimer?.cancel();
    _posStream?.cancel();

    final initialPos = await _resolveTripLocation();
    if (initialPos == null) {
      _showSnack(
          'Live location is unavailable. Enable GPS to continue trip tracking.',
          error: true);
      return;
    }
    _lastTripPosition = initialPos;
    if (mounted) {
      setState(
          () => _center = LatLng(initialPos.latitude, initialPos.longitude));
      _updateSelfMarker(initialPos.latitude, initialPos.longitude);
      // Now that we have real GPS, re-fetch route with accurate origin
      _fetchRouteForCurrentStatus();
    }
    if (!_hasLiveLocationAccess) {
      _showSnack('Enable GPS permission to resume live customer tracking.',
          error: true);
      return;
    }

    // GPS stream: high-accuracy (active trip), but emits only on movement ≥ 5 m
    _posStream = Geolocator.getPositionStream(
      locationSettings: AndroidSettings(
        accuracy: LocationAccuracy.high,
        distanceFilter: 5,
        intervalDuration: Duration(seconds: 3),
        foregroundNotificationConfig: ForegroundNotificationConfig(
          notificationText: 'JAGO Pro Pilot is sharing your live trip location',
          notificationTitle: 'Trip tracking active',
          enableWakeLock: true,
          setOngoing: true,
        ),
      ),
    ).listen((pos) {
      _lastTripPosition = pos;
      if (!mounted) return;
      setState(() => _center = LatLng(pos.latitude, pos.longitude));
      if (_autoFollowDriver) {
        _mapController?.animateCamera(CameraUpdate.newLatLng(_center));
      }
      _updateSelfMarker(pos.latitude, pos.longitude);
      _computeDistanceAndEta(pos.latitude, pos.longitude);
      _updateNavigationProgress();
      _maybeHandleOffRoute(pos.latitude, pos.longitude);
    }, onError: (_) {
      _showSnack('Could not read live location. Check GPS permissions.',
          error: true);
    });

    // Server-update timer: every 3 s — uses cached position from stream
    _locationTimer = Timer.periodic(const Duration(seconds: 3), (_) async {
      final pos = _lastTripPosition;
      if (pos == null || !mounted) return;
      _socket.sendLocation(
          lat: pos.latitude,
          lng: pos.longitude,
          speed: pos.speed,
          remainingDistanceMeters: _distanceToTargetM.round(),
          etaSeconds: _etaSec);
      final locHeaders = await AuthService.getHeaders();
      http
          .post(Uri.parse(ApiConfig.driverLocation),
              headers: {...locHeaders, 'Content-Type': 'application/json'},
              body: jsonEncode({
                'lat': pos.latitude,
                'lng': pos.longitude,
                'isOnline': true,
                'remainingDistanceMeters': _distanceToTargetM.round(),
                'etaSeconds': _etaSec,
              }))
          .catchError((_) => http.Response('', 500));
    });
  }

  void _computeDistanceAndEta(double lat, double lng) {
    if (_trip == null) return;
    final toPickup = _status == 'accepted' || _status == 'driver_assigned';
    if (lat == 0 && lng == 0) return; // Ignore invalid coordinates
    final tLat = toPickup
        ? double.tryParse(_trip!['pickupLat']?.toString() ?? '') ?? 0.0
        : double.tryParse(_trip!['destinationLat']?.toString() ?? '') ?? 0.0;
    final tLng = toPickup
        ? double.tryParse(_trip!['pickupLng']?.toString() ?? '') ?? 0.0
        : double.tryParse(_trip!['destinationLng']?.toString() ?? '') ?? 0.0;
    if (tLat == 0 && tLng == 0) return;
    final dm = Geolocator.distanceBetween(lat, lng, tLat, tLng);
    final etaS = dm > 0 ? (dm / 8.33).round() : 0;
    if (mounted)
      setState(() {
        _distanceToTargetM = dm;
        _etaSec = etaS;
      });
    if (toPickup) {
      final near = dm <= 100;
      if (mounted && near != _nearPickup) {
        setState(() => _nearPickup = near);
        if (near) _showSnack('You are near the pickup location!');
      }
    }
  }

  // ── Cancel reasons ────────────────────────────────────────────────────────

  Future<void> _loadCancelReasons() async {
    try {
      final res = await http.get(Uri.parse(ApiConfig.configs));
      if (res.statusCode == 200) {
        final data = jsonDecode(res.body);
        final reasons = (data['cancellationReasons'] as List<dynamic>? ?? [])
            .where(
                (r) => r['userType'] == 'driver' || r['user_type'] == 'driver')
            .map((r) => r['reason']?.toString() ?? '')
            .where((r) => r.isNotEmpty)
            .toList();
        if (mounted) setState(() => _cancelReasons = reasons);
      }
    } catch (_) {}
  }

  // ── Trip actions ──────────────────────────────────────────────────────────

  Future<void> _nextStep() async {
    if (_status == 'arrived') {
      _showOtpBottomSheet();
      return;
    }
    if (_status == 'in_progress' || _status == 'on_the_way') {
      final confirmed = await _confirmCashBeforeComplete();
      if (!confirmed) return;
    }
    setState(() => _loading = true);
    final h = await AuthService.getHeaders();
    final tripId = _trip?['id'] ?? _trip?['tripId'] ?? '';

    try {
      if (_status == 'accepted' || _status == 'driver_assigned') {
        final res = await http.post(Uri.parse(ApiConfig.driverArrived),
            headers: {...h, 'Content-Type': 'application/json'},
            body: jsonEncode({'tripId': tripId}));
        if (!mounted) return;
        if (res.statusCode == 200) {
          setState(() {
            _status = 'arrived';
            _loading = false;
          });
          print('[TRIP] ✅ Arrived at pickup — tripId=$tripId');
          _showSnack('Arrived! Ask customer for OTP 📍');
          // Pre-fetch destination route while driver waits for pickup OTP.
          final t = _trip;
          if (t != null) {
            final dLat = double.tryParse(t['destinationLat']?.toString() ?? t['destination_lat']?.toString() ?? '') ?? 0.0;
            final dLng = double.tryParse(t['destinationLng']?.toString() ?? t['destination_lng']?.toString() ?? '') ?? 0.0;
            final origin = _lastTripPosition;
            final fromLat = origin?.latitude ?? _center.latitude;
            final fromLng = origin?.longitude ?? _center.longitude;
            if (dLat != 0 && dLng != 0) {
              await _fetchRoute(fromLat, fromLng, dLat, dLng);
            }
          }
          if (mounted && _status == 'arrived') {
            Future.delayed(const Duration(milliseconds: 250), () {
              if (mounted && _status == 'arrived') {
                _showOtpBottomSheet();
              }
            });
          }
        } else {
          final err = jsonDecode(res.body);
          _showSnack(err['message'] ?? 'Error', error: true);
          setState(() => _loading = false);
        }
      } else if (_status == 'in_progress' || _status == 'on_the_way') {
        await _completeTrip(h);
        return;
      }
    } catch (_) {
      if (!mounted) return;
      _showSnack('Network error. Try again.', error: true);
      setState(() => _loading = false);
    }
  }

  bool get _isCashPayment {
    final pm = (_trip?['paymentMethod'] ?? _trip?['payment_method'] ?? 'cash')
        .toString()
        .toLowerCase();
    return pm == 'cash' || pm == 'cod';
  }

  Future<bool> _confirmCashBeforeComplete() async {
    if (!_isCashPayment) return true;
    final fare = double.tryParse(
            (_trip?['estimatedFare'] ?? _trip?['estimated_fare'] ?? 0)
                .toString()) ??
        0;
    final result = await showModalBottomSheet<bool>(
      context: context,
      isScrollControlled: true,
      backgroundColor: Colors.transparent,
      builder: (ctx) => Container(
        decoration: const BoxDecoration(
          color: Colors.white,
          borderRadius: BorderRadius.vertical(top: Radius.circular(30)),
        ),
        padding: const EdgeInsets.fromLTRB(24, 14, 24, 28),
        child: SafeArea(
          top: false,
          child: Column(mainAxisSize: MainAxisSize.min, children: [
            Container(
              width: 44,
              height: 4,
              decoration: BoxDecoration(
                color: JT.border,
                borderRadius: BorderRadius.circular(2),
              ),
            ),
            const SizedBox(height: 22),
            Container(
              width: 74,
              height: 74,
              decoration: BoxDecoration(
                color: JT.warning.withValues(alpha: 0.12),
                shape: BoxShape.circle,
              ),
              child: const Icon(Icons.payments_rounded,
                  color: JT.warning, size: 38),
            ),
            const SizedBox(height: 18),
            Text(
              'Did you collect ₹${fare.toStringAsFixed(0)} cash?',
              textAlign: TextAlign.center,
              style: GoogleFonts.poppins(
                color: JT.textPrimary,
                fontSize: 22,
                fontWeight: FontWeight.w600,
              ),
            ),
            const SizedBox(height: 10),
            Text(
              'Confirm only after cash is collected. This closes the ride and updates customer/admin in realtime.',
              textAlign: TextAlign.center,
              style: GoogleFonts.poppins(
                color: JT.textSecondary,
                fontSize: 13,
                height: 1.45,
              ),
            ),
            const SizedBox(height: 24),
            Row(children: [
              Expanded(
                child: OutlinedButton(
                  onPressed: () => Navigator.pop(ctx, false),
                  style: OutlinedButton.styleFrom(
                    foregroundColor: JT.textPrimary,
                    side: BorderSide(color: JT.border),
                    shape: RoundedRectangleBorder(
                      borderRadius: BorderRadius.circular(16),
                    ),
                    padding: const EdgeInsets.symmetric(vertical: 16),
                  ),
                  child: Text('Go Back',
                      style: GoogleFonts.poppins(
                          fontWeight: FontWeight.w600, fontSize: 15)),
                ),
              ),
              const SizedBox(width: 12),
              Expanded(
                child: ElevatedButton(
                  onPressed: () => Navigator.pop(ctx, true),
                  style: ElevatedButton.styleFrom(
                    backgroundColor: JT.warning,
                    foregroundColor: JT.textPrimary,
                    elevation: 0,
                    shape: RoundedRectangleBorder(
                      borderRadius: BorderRadius.circular(16),
                    ),
                    padding: const EdgeInsets.symmetric(vertical: 16),
                  ),
                  child: Text('Collected',
                      style: GoogleFonts.poppins(
                          fontWeight: FontWeight.w700, fontSize: 15)),
                ),
              ),
            ]),
          ]),
        ),
      ),
    );
    return result == true;
  }

  Future<void> _completeTrip(Map<String, String> authHeaders) async {
    final tripId = _trip?['id'] ?? _trip?['tripId'] ?? '';
    final estFare = _trip?['estimatedFare'] ?? _trip?['estimated_fare'] ?? 0.0;
    final estDist =
        _trip?['estimatedDistance'] ?? _trip?['estimated_distance'] ?? 0.0;
    try {
      final res = await http.post(Uri.parse(ApiConfig.driverCompleteTrip),
          headers: {...authHeaders, 'Content-Type': 'application/json'},
          body: jsonEncode({
            'tripId': tripId,
            'actualFare': estFare,
            'actualDistance': estDist
          }));
      if (res.statusCode == 200) {
        final data = jsonDecode(res.body);
        final pricing = data['pricing'] as Map<String, dynamic>? ?? {};
        final rideFare = pricing['rideFare'] ??
            data['trip']?['actualFare'] ??
            data['trip']?['actual_fare'] ??
            estFare;
        final driverEarnings = pricing['driverWalletCredit'] ?? rideFare;
        final commission = pricing['platformDeduction'] ?? 0;
        _socket.setActiveTrip(null); // clear trip room tracking
        _locationTimer?.cancel();
        _posStream?.cancel();
        _stopTripTimer();
        print(
            '[TRIP] ✅ Ride completed — tripId=$tripId fare=$rideFare earnings=$driverEarnings');
        if (!mounted) return;
        _showCompletionSheet(
          rideFare.toString(),
          driverEarnings: driverEarnings.toString(),
          commission: commission.toString(),
        );
      } else {
        String errMsg = 'Error completing trip';
        try {
          errMsg = (jsonDecode(res.body) as Map)['message'] ?? errMsg;
        } catch (_) {}
        if (!mounted) return;
        _showSnack(errMsg, error: true);
        setState(() => _loading = false);
      }
    } catch (e) {
      print('[TRIP] ❌ complete-trip network error: $e');
      if (!mounted) return;
      _showSnack('Network error. Please tap "Complete" again.', error: true);
      setState(() => _loading = false);
    }
  }

  Future<void> _cancelTrip(String reason) async {
    setState(() => _loading = true);
    final cancelHeaders = await AuthService.getHeaders();
    final tripId = _trip?['id'] ?? _trip?['tripId'] ?? '';
    try {
      await http.post(Uri.parse(ApiConfig.driverCancelTrip),
          headers: {...cancelHeaders, 'Content-Type': 'application/json'},
          body: jsonEncode({'tripId': tripId, 'reason': reason}));
    } catch (_) {}
    _socket.setActiveTrip(null); // clear trip room tracking
    _locationTimer?.cancel();
    _stopTripTimer();
    if (!mounted) return;
    Navigator.pushAndRemoveUntil(context,
        MaterialPageRoute(builder: (_) => const HomeScreen()), (_) => false);
  }

  // ── OTP ───────────────────────────────────────────────────────────────────

  void _showOtpBottomSheet() {
    _otpCtrl.clear();
    showModalBottomSheet(
      context: context,
      isScrollControlled: true,
      backgroundColor: Colors.transparent,
      builder: (ctx) => Padding(
        padding: EdgeInsets.only(bottom: MediaQuery.of(ctx).viewInsets.bottom),
        child: Container(
          decoration: const BoxDecoration(
            color: Colors.white,
            borderRadius: BorderRadius.vertical(top: Radius.circular(28)),
          ),
          padding: const EdgeInsets.fromLTRB(24, 12, 24, 32),
          child: Column(mainAxisSize: MainAxisSize.min, children: [
            Container(
                width: 44,
                height: 4,
                decoration: BoxDecoration(
                    color: JT.border, borderRadius: BorderRadius.circular(2))),
            const SizedBox(height: 20),
            Row(children: [
              Container(
                  padding: const EdgeInsets.all(12),
                  decoration: BoxDecoration(
                      color: JT.primary.withValues(alpha: 0.10),
                      borderRadius: BorderRadius.circular(16)),
                  child: const Icon(Icons.lock_open_rounded,
                      color: JT.primary, size: 28)),
              const SizedBox(width: 14),
              Expanded(
                  child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                    Text('Enter Customer OTP',
                        style: GoogleFonts.poppins(
                            color: JT.textPrimary,
                            fontWeight: FontWeight.w400,
                            fontSize: 18)),
                    Text('Ask customer for OTP shown in JAGO Pro app',
                        style: GoogleFonts.poppins(
                            color: JT.textSecondary, fontSize: 12)),
                  ])),
            ]),
            const SizedBox(height: 24),
            Container(
              decoration: BoxDecoration(
                color: JT.bgSoft,
                borderRadius: BorderRadius.circular(16),
                border: Border.all(
                    color: JT.primary.withValues(alpha: 0.3), width: 1.5),
              ),
              child: TextField(
                controller: _otpCtrl,
                keyboardType: TextInputType.number,
                maxLength: 6,
                inputFormatters: [FilteringTextInputFormatter.digitsOnly],
                textAlign: TextAlign.center,
                autofocus: true,
                style: GoogleFonts.poppins(
                    color: JT.textPrimary,
                    fontSize: 32,
                    fontWeight: FontWeight.w500,
                    letterSpacing: 12),
                decoration: InputDecoration(
                  counterText: '',
                  hintText: '——————',
                  hintStyle: GoogleFonts.poppins(
                      color: JT.iconInactive, letterSpacing: 8, fontSize: 24),
                  border: InputBorder.none,
                  contentPadding: const EdgeInsets.symmetric(vertical: 18),
                ),
              ),
            ),
            const SizedBox(height: 20),
            Row(children: [
              Expanded(
                  child: OutlinedButton(
                      style: OutlinedButton.styleFrom(
                        foregroundColor: JT.textSecondary,
                        side: BorderSide(color: JT.border),
                        shape: RoundedRectangleBorder(
                            borderRadius: BorderRadius.circular(14)),
                        padding: const EdgeInsets.symmetric(vertical: 16),
                      ),
                      onPressed: () => Navigator.pop(ctx),
                      child: Text('Cancel',
                          style: GoogleFonts.poppins(
                              fontWeight: FontWeight.w400)))),
              const SizedBox(width: 12),
              Expanded(
                  flex: 2,
                  child: ElevatedButton(
                      style: ElevatedButton.styleFrom(
                          backgroundColor: JT.primary,
                          foregroundColor: Colors.white,
                          shape: RoundedRectangleBorder(
                              borderRadius: BorderRadius.circular(14)),
                          padding: const EdgeInsets.symmetric(vertical: 16),
                          elevation: 0),
                      onPressed: () async {
                        final otp = _otpCtrl.text.trim();
                        if (otp.length < 4) return;
                        Navigator.pop(ctx);
                        await _verifyOtpAndStart(otp);
                      },
                      child: Text('Verify & Start Trip →',
                          style: GoogleFonts.poppins(
                              fontWeight: FontWeight.w400, fontSize: 14)))),
            ]),
            const SizedBox(height: 16),
            TextButton(
                onPressed: () {
                  Navigator.pop(ctx);
                  _showCancelDialog();
                },
                child: Text('Trouble with OTP? Cancel Trip',
                    style: GoogleFonts.poppins(
                        color: JT.error,
                        fontSize: 12,
                        fontWeight: FontWeight.w400))),
          ]),
        ),
      ),
    );
  }

  Future<void> _verifyOtpAndStart(String otp) async {
    setState(() => _loading = true);
    final h = await AuthService.getHeaders();
    final tripId = _trip?['id'] ?? _trip?['tripId'] ?? '';
    try {
      final res = await http.post(Uri.parse(ApiConfig.driverVerifyOtp),
          headers: {...h, 'Content-Type': 'application/json'},
          body: jsonEncode({'tripId': tripId, 'otp': otp}));
      if (res.statusCode == 200) {
        print('[TRIP] ✅ OTP verified — trip started — tripId=$tripId');
        if (!mounted) return;
        setState(() {
          _status = 'in_progress';
          _loading = false;
        });
        _startTripTimer();

        // Use real GPS position as route origin (not stale map center)
        final origin = _lastTripPosition;
        final fromLat = origin?.latitude ?? _center.latitude;
        final fromLng = origin?.longitude ?? _center.longitude;

        // Animate map + fetch route to destination
        final dLat = double.tryParse(_trip?['destinationLat']?.toString() ??
                _trip?['destination_lat']?.toString() ??
                '') ??
            0;
        final dLng = double.tryParse(_trip?['destinationLng']?.toString() ??
                _trip?['destination_lng']?.toString() ??
                '') ??
            0;
        if (dLat != 0 && dLng != 0) {
          _mapController?.animateCamera(
              CameraUpdate.newLatLngZoom(LatLng(dLat, dLng), 15));
          // Fetch polyline using actual GPS position, not default map center
          await _fetchRoute(fromLat, fromLng, dLat, dLng);
        }
        _showSnack('Trip started! Follow the map to reach destination');
        _showPickupPhotoPrompt(tripId);
      } else {
        final err = jsonDecode(res.body);
        if (!mounted) return;
        _showSnack(err['message'] ?? 'Wrong OTP', error: true);
        setState(() => _loading = false);
      }
    } catch (_) {
      if (!mounted) return;
      _showSnack('Network error. Try again.', error: true);
      setState(() => _loading = false);
    }
  }

  // ── Pickup photo ──────────────────────────────────────────────────────────

  void _showPickupPhotoPrompt(String tripId) {
    if (!mounted) return;
    showModalBottomSheet(
      context: context,
      backgroundColor: JT.surface,
      shape: const RoundedRectangleBorder(
          borderRadius: BorderRadius.vertical(top: Radius.circular(24))),
      builder: (_) => Padding(
        padding: const EdgeInsets.fromLTRB(24, 20, 24, 32),
        child: Column(mainAxisSize: MainAxisSize.min, children: [
          Container(
              width: 40,
              height: 4,
              decoration: BoxDecoration(
                  color: JT.border, borderRadius: BorderRadius.circular(2))),
          const SizedBox(height: 20),
          Container(
            padding: const EdgeInsets.all(14),
            decoration: BoxDecoration(
                color: JT.surfaceAlt,
                borderRadius: BorderRadius.circular(16),
                border: Border.all(color: JT.border)),
            child: Row(children: [
              Container(
                  padding: const EdgeInsets.all(10),
                  decoration: BoxDecoration(
                      color: JT.primary.withValues(alpha: 0.10),
                      shape: BoxShape.circle),
                  child: const Icon(Icons.camera_alt_rounded,
                      color: JT.primary, size: 26)),
              const SizedBox(width: 14),
              Expanded(
                  child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                    Text('Pickup Photo',
                        style: GoogleFonts.poppins(
                            color: JT.textPrimary,
                            fontWeight: FontWeight.w400,
                            fontSize: 15)),
                    Text('Capture for ride security',
                        style: GoogleFonts.poppins(
                            color: JT.textSecondary, fontSize: 12)),
                  ])),
            ]),
          ),
          const SizedBox(height: 20),
          Row(children: [
            Expanded(
                child: OutlinedButton(
                    style: OutlinedButton.styleFrom(
                        foregroundColor: JT.textSecondary,
                        side: BorderSide(color: JT.border),
                        shape: RoundedRectangleBorder(
                            borderRadius: BorderRadius.circular(12)),
                        padding: const EdgeInsets.symmetric(vertical: 14)),
                    onPressed: () => Navigator.pop(context),
                    child: Text('Skip',
                        style:
                            GoogleFonts.poppins(fontWeight: FontWeight.w400)))),
            const SizedBox(width: 12),
            Expanded(
                flex: 2,
                child: ElevatedButton.icon(
                    style: ElevatedButton.styleFrom(
                        backgroundColor: JT.primary,
                        foregroundColor: Colors.white,
                        shape: RoundedRectangleBorder(
                            borderRadius: BorderRadius.circular(12)),
                        padding: const EdgeInsets.symmetric(vertical: 14),
                        elevation: 0),
                    icon: const Icon(Icons.camera_alt_rounded, size: 18),
                    label: Text('Take Photo',
                        style:
                            GoogleFonts.poppins(fontWeight: FontWeight.w400)),
                    onPressed: () {
                      Navigator.pop(context);
                      _captureAndUploadPhoto(tripId);
                    })),
          ]),
        ]),
      ),
    );
  }

  Future<void> _captureAndUploadPhoto(String tripId) async {
    try {
      final picker = ImagePicker();
      final picked = await picker.pickImage(
          source: ImageSource.camera, imageQuality: 70, maxWidth: 1280);
      if (picked == null || !mounted) return;
      _showSnack('Uploading photo…');
      final ph = await AuthService.getHeaders();
      final req = http.MultipartRequest('POST', Uri.parse(ApiConfig.tripPhoto));
      req.headers.addAll(ph);
      req.fields['tripId'] = tripId;
      req.files.add(await http.MultipartFile.fromPath('photo', picked.path));
      final resp = await req.send();
      if (!mounted) return;
      _showSnack(
          resp.statusCode == 200 ? 'Photo saved ✓' : 'Photo upload failed',
          error: resp.statusCode != 200);
    } catch (_) {
      if (mounted) _showSnack('Photo upload failed', error: true);
    }
  }

  // ── Completion sheet ──────────────────────────────────────────────────────

  void _showCompletionSheet(String fare,
      {String driverEarnings = '0', String commission = '0'}) {
    int selectedRating = 0;
    bool ratingSubmitted = false;
    final tripId = _trip?['id'] ?? _trip?['tripId'] ?? '';
    final pm = _trip?['paymentMethod'] ?? _trip?['payment_method'] ?? 'cash';
    final isCash = pm == 'cash';
    final netEarnings = double.tryParse(driverEarnings) ?? 0.0;
    final commissionAmt = double.tryParse(commission) ?? 0.0;
    final fullFare = double.tryParse(fare) ?? 0.0;
    final elapsed = _formatElapsed(_tripElapsedSec);

    showModalBottomSheet(
      context: context,
      isScrollControlled: true,
      backgroundColor: Colors.transparent,
      isDismissible: false,
      enableDrag: false,
      builder: (ctx) => StatefulBuilder(
        builder: (ctx, setS) => Container(
          decoration: const BoxDecoration(
            color: Colors.white,
            borderRadius: BorderRadius.vertical(top: Radius.circular(32)),
          ),
          padding: const EdgeInsets.fromLTRB(24, 12, 24, 32),
          child: SingleChildScrollView(
              child: Column(mainAxisSize: MainAxisSize.min, children: [
            Container(
                width: 44,
                height: 4,
                decoration: BoxDecoration(
                    color: JT.border, borderRadius: BorderRadius.circular(2))),
            const SizedBox(height: 20),
            // Success icon
            Container(
                width: 80,
                height: 80,
                decoration: BoxDecoration(
                    color: JT.success.withValues(alpha: 0.10),
                    shape: BoxShape.circle,
                    border: Border.all(
                        color: JT.success.withValues(alpha: 0.3), width: 2)),
                child: const Icon(Icons.check_rounded,
                    color: JT.success, size: 44)),
            const SizedBox(height: 16),
            Text('Trip Complete!',
                style: GoogleFonts.poppins(
                    color: JT.textPrimary,
                    fontSize: 22,
                    fontWeight: FontWeight.w500)),
            const SizedBox(height: 4),
            Text('Great job! Ride completed successfully.',
                style:
                    GoogleFonts.poppins(color: JT.textSecondary, fontSize: 13)),
            const SizedBox(height: 20),
            // Earnings card
            Container(
              padding: const EdgeInsets.all(20),
              decoration: BoxDecoration(
                gradient: LinearGradient(
                    colors: [JT.primary, JT.primary.withValues(alpha: 0.75)],
                    begin: Alignment.topLeft,
                    end: Alignment.bottomRight),
                borderRadius: BorderRadius.circular(20),
                boxShadow: JT.btnShadow,
              ),
              child: Column(children: [
                Text('YOUR EARNINGS',
                    style: GoogleFonts.poppins(
                        color: Colors.white70,
                        fontSize: 11,
                        fontWeight: FontWeight.w500,
                        letterSpacing: 1.5)),
                const SizedBox(height: 6),
                Text('₹${netEarnings.toStringAsFixed(0)}',
                    style: GoogleFonts.poppins(
                        color: Colors.white,
                        fontSize: 48,
                        fontWeight: FontWeight.w500,
                        height: 1.1)),
                const SizedBox(height: 12),
                Container(height: 1, color: Colors.white24),
                const SizedBox(height: 12),
                Row(
                    mainAxisAlignment: MainAxisAlignment.spaceBetween,
                    children: [
                      _completionStat(
                          'Fare', '₹${fullFare.toStringAsFixed(0)}'),
                      _completionStat(
                          'Commission', '₹${commissionAmt.toStringAsFixed(0)}'),
                      _completionStat('Duration', elapsed),
                    ]),
              ]),
            ),
            const SizedBox(height: 14),
            // Payment instruction
            if (isCash)
              Container(
                padding: const EdgeInsets.all(16),
                decoration: BoxDecoration(
                    color: const Color(0xFFF0FDF4),
                    borderRadius: BorderRadius.circular(16),
                    border:
                        Border.all(color: JT.success.withValues(alpha: 0.35))),
                child: Row(children: [
                  Container(
                      padding: const EdgeInsets.all(10),
                      decoration: BoxDecoration(
                          color: JT.success.withValues(alpha: 0.12),
                          borderRadius: BorderRadius.circular(12)),
                      child: const Icon(Icons.payments_rounded,
                          color: JT.success, size: 24)),
                  const SizedBox(width: 14),
                  Expanded(
                      child: Column(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                        Text('Collect ₹${fullFare.toStringAsFixed(0)} Cash',
                            style: GoogleFonts.poppins(
                                color: JT.success,
                                fontWeight: FontWeight.w400,
                                fontSize: 15)),
                        Text(
                            'Platform fee ₹${commissionAmt.toStringAsFixed(0)} deducted from your wallet',
                            style: GoogleFonts.poppins(
                                color: JT.textSecondary, fontSize: 11)),
                      ])),
                ]),
              )
            else
              Container(
                padding: const EdgeInsets.all(16),
                decoration: BoxDecoration(
                    color: JT.primary.withValues(alpha: 0.05),
                    borderRadius: BorderRadius.circular(16),
                    border:
                        Border.all(color: JT.primary.withValues(alpha: 0.2))),
                child: Row(children: [
                  const Icon(Icons.account_balance_wallet_rounded,
                      color: JT.primary, size: 24),
                  const SizedBox(width: 14),
                  Expanded(
                      child: Column(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                        Text(
                            '₹${netEarnings.toStringAsFixed(0)} added to wallet',
                            style: GoogleFonts.poppins(
                                color: JT.primary,
                                fontWeight: FontWeight.w400,
                                fontSize: 15)),
                        Text(
                            pm == 'wallet'
                                ? 'Customer wallet deducted'
                                : 'Customer paid online',
                            style: GoogleFonts.poppins(
                                color: JT.textSecondary, fontSize: 11)),
                      ])),
                ]),
              ),
            const SizedBox(height: 14),
            // Rating
            Container(
              padding: const EdgeInsets.all(16),
              decoration: BoxDecoration(
                  color: JT.bgSoft,
                  borderRadius: BorderRadius.circular(16),
                  border: Border.all(color: JT.border)),
              child: ratingSubmitted
                  ? Row(mainAxisAlignment: MainAxisAlignment.center, children: [
                      const Icon(Icons.star_rounded,
                          color: Colors.amber, size: 22),
                      const SizedBox(width: 8),
                      Text('Thank you for rating!',
                          style: GoogleFonts.poppins(
                              color: JT.textSecondary,
                              fontWeight: FontWeight.w400)),
                    ])
                  : Column(children: [
                      Text('Rate this customer',
                          style: GoogleFonts.poppins(
                              color: JT.textPrimary,
                              fontSize: 14,
                              fontWeight: FontWeight.w500)),
                      const SizedBox(height: 10),
                      Row(
                          mainAxisAlignment: MainAxisAlignment.center,
                          children: [
                            for (int i = 1; i <= 5; i++)
                              GestureDetector(
                                onTap: () async {
                                  setS(() => selectedRating = i);
                                  final rh = await AuthService.getHeaders();
                                  try {
                                    await http.post(
                                        Uri.parse(ApiConfig.driverRateCustomer),
                                        headers: {
                                          ...rh,
                                          'Content-Type': 'application/json'
                                        },
                                        body: jsonEncode(
                                            {'tripId': tripId, 'rating': i}));
                                  } catch (_) {}
                                  setS(() => ratingSubmitted = true);
                                },
                                child: Padding(
                                    padding: const EdgeInsets.symmetric(
                                        horizontal: 6),
                                    child: Icon(
                                        i <= selectedRating
                                            ? Icons.star_rounded
                                            : Icons.star_border_rounded,
                                        color: Colors.amber,
                                        size: 40)),
                              ),
                          ]),
                    ]),
            ),
            const SizedBox(height: 20),
            SizedBox(
              width: double.infinity,
              height: 56,
              child: ElevatedButton(
                  style: ElevatedButton.styleFrom(
                      backgroundColor: JT.primary,
                      foregroundColor: Colors.white,
                      shape: RoundedRectangleBorder(
                          borderRadius: BorderRadius.circular(16)),
                      elevation: 0),
                  onPressed: () {
                    Navigator.pop(ctx);
                    Navigator.pushAndRemoveUntil(
                        context,
                        MaterialPageRoute(builder: (_) => const HomeScreen()),
                        (_) => false);
                  },
                  child: Text('Back to Home →',
                      style: GoogleFonts.poppins(
                          fontWeight: FontWeight.w400, fontSize: 16))),
            ),
          ])),
        ),
      ),
    );
  }

  Widget _completionStat(String label, String value) {
    return Column(children: [
      Text(value,
          style: GoogleFonts.poppins(
              color: Colors.white, fontWeight: FontWeight.w400, fontSize: 15)),
      Text(label,
          style: GoogleFonts.poppins(
              color: Colors.white60,
              fontSize: 10,
              fontWeight: FontWeight.w400)),
    ]);
  }

  // ── Cancel dialog ─────────────────────────────────────────────────────────

  void _showCancelDialog() {
    final reasons = _cancelReasons.isNotEmpty
        ? _cancelReasons
        : [
            'Customer not at pickup location',
            'Customer is not responding',
            'Vehicle breakdown',
            'Customer requested to cancel',
            'Other reason',
          ];
    showModalBottomSheet(
      context: context,
      backgroundColor: JT.surface,
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
          const SizedBox(height: 16),
          Row(children: [
            Container(
                padding: const EdgeInsets.all(8),
                decoration: BoxDecoration(
                    color: JT.error.withValues(alpha: 0.08),
                    borderRadius: BorderRadius.circular(10)),
                child: const Icon(Icons.cancel_rounded,
                    color: JT.error, size: 20)),
            const SizedBox(width: 12),
            Text('Cancel Reason',
                style: GoogleFonts.poppins(
                    color: JT.textPrimary,
                    fontSize: 17,
                    fontWeight: FontWeight.w400)),
          ]),
          const SizedBox(height: 12),
          ...reasons.map((r) => ListTile(
              title: Text(r,
                  style:
                      GoogleFonts.poppins(color: JT.textPrimary, fontSize: 13)),
              leading: const Icon(Icons.chevron_right_rounded,
                  color: JT.iconInactive, size: 18),
              contentPadding: EdgeInsets.zero,
              dense: true,
              onTap: () {
                Navigator.pop(context);
                _cancelTrip(r);
              })),
          const SizedBox(height: 8),
        ]),
      ),
    );
  }

  // ── Delivery OTP ──────────────────────────────────────────────────────────

  void _showDeliveryOtpDialog() {
    final ctrl = TextEditingController();
    showDialog(
      context: context,
      barrierDismissible: false,
      builder: (ctx) => Dialog(
        backgroundColor: JT.surface,
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(20)),
        child: Padding(
          padding: const EdgeInsets.all(24),
          child: Column(mainAxisSize: MainAxisSize.min, children: [
            Container(
                padding: const EdgeInsets.all(12),
                decoration: BoxDecoration(
                    color: JT.warning.withValues(alpha: 0.10),
                    shape: BoxShape.circle),
                child: const Icon(Icons.local_shipping_rounded,
                    color: JT.warning, size: 32)),
            const SizedBox(height: 16),
            Text('Delivery OTP',
                style: GoogleFonts.poppins(
                    color: JT.textPrimary,
                    fontWeight: FontWeight.w400,
                    fontSize: 18)),
            const SizedBox(height: 4),
            Text('Ask receiver for OTP to confirm delivery',
                style:
                    GoogleFonts.poppins(color: JT.textSecondary, fontSize: 13),
                textAlign: TextAlign.center),
            const SizedBox(height: 20),
            Container(
                decoration: BoxDecoration(
                    color: JT.bgSoft,
                    borderRadius: BorderRadius.circular(14),
                    border:
                        Border.all(color: JT.warning.withValues(alpha: 0.3))),
                child: TextField(
                  controller: ctrl,
                  keyboardType: TextInputType.number,
                  maxLength: 6,
                  inputFormatters: [FilteringTextInputFormatter.digitsOnly],
                  textAlign: TextAlign.center,
                  style: GoogleFonts.poppins(
                      color: JT.textPrimary,
                      fontSize: 28,
                      fontWeight: FontWeight.w500,
                      letterSpacing: 10),
                  decoration: InputDecoration(
                      counterText: '',
                      hintText: '------',
                      hintStyle: GoogleFonts.poppins(
                          color: JT.iconInactive,
                          letterSpacing: 10,
                          fontSize: 24),
                      border: InputBorder.none,
                      contentPadding: const EdgeInsets.symmetric(vertical: 16)),
                )),
            const SizedBox(height: 20),
            Row(children: [
              Expanded(
                  child: TextButton(
                      onPressed: () => Navigator.pop(ctx),
                      style: TextButton.styleFrom(
                          padding: const EdgeInsets.symmetric(vertical: 14),
                          shape: RoundedRectangleBorder(
                              borderRadius: BorderRadius.circular(12))),
                      child: Text('Cancel',
                          style: GoogleFonts.poppins(
                              color: JT.textSecondary,
                              fontWeight: FontWeight.w400)))),
              const SizedBox(width: 12),
              Expanded(
                  child: ElevatedButton(
                      style: ElevatedButton.styleFrom(
                          backgroundColor: JT.warning,
                          foregroundColor: Colors.white,
                          shape: RoundedRectangleBorder(
                              borderRadius: BorderRadius.circular(12)),
                          padding: const EdgeInsets.symmetric(vertical: 14),
                          elevation: 0),
                      onPressed: () async {
                        final otp = ctrl.text.trim();
                        if (otp.isEmpty) return;
                        Navigator.pop(ctx);
                        await _verifyDeliveryOtp(otp);
                      },
                      child: Text('Verify ✓',
                          style: GoogleFonts.poppins(
                              fontWeight: FontWeight.w400)))),
            ]),
          ]),
        ),
      ),
    ).then((_) => ctrl.dispose());
  }

  Future<void> _verifyDeliveryOtp(String otp) async {
    setState(() => _loading = true);
    final h = await AuthService.getHeaders();
    final tripId = _trip?['id'] ?? _trip?['tripId'] ?? '';
    try {
      final res = await http.post(Uri.parse(ApiConfig.verifyDeliveryOtp),
          headers: {...h, 'Content-Type': 'application/json'},
          body: jsonEncode({'tripId': tripId, 'otp': otp}));
      if (!mounted) return;
      _showSnack(
          res.statusCode == 200
              ? 'Delivery verified! ✓'
              : (jsonDecode(res.body)['message'] ?? 'Wrong OTP'),
          error: res.statusCode != 200);
    } catch (_) {
      if (!mounted) return;
      _showSnack('Network error', error: true);
    }
    if (mounted) setState(() => _loading = false);
  }

  // ── Call / Navigation / SOS ───────────────────────────────────────────────

  void _startInAppCall(String contactName) {
    final customerId =
        _trip?['customerId']?.toString() ?? _trip?['customer_id']?.toString();
    final tripId =
        _trip?['id']?.toString() ?? _trip?['tripId']?.toString() ?? '';
    if (customerId == null || customerId.isEmpty) return;
    Navigator.of(context).push(MaterialPageRoute(
        builder: (_) => CallScreen(
            contactName: contactName,
            tripId: tripId,
            targetUserId: customerId)));
  }

  void _openTripChat() {
    final tripId =
        _trip?['id']?.toString() ?? _trip?['tripId']?.toString() ?? '';
    showModalBottomSheet(
        context: context,
        isScrollControlled: true,
        backgroundColor: Colors.transparent,
        builder: (_) => TripChatSheet(tripId: tripId, senderName: 'Driver'));
  }

  Future<void> _openNavigation() async {
    if (_trip == null) {
      _showSnack('Trip data missing. Refresh the trip once.', error: true);
      return;
    }
    final target = _currentTargetLatLng();
    if (target == null) {
      _showSnack(
          _isHeadingToPickup
              ? 'Pickup location is not ready yet.'
              : 'Destination location is not ready yet.',
          error: true);
      return;
    }

    _autoFollowDriver = false;
    await _fetchRouteForCurrentStatus();
    await _focusMapOnRoute();
    _showSnack('Showing in-app route to ${_currentTargetLabel()}');
  }

  Future<void> _triggerSos() async {
    final confirm = await showDialog<bool>(
        context: context,
        builder: (_) => AlertDialog(
                backgroundColor: JT.surface,
                shape: RoundedRectangleBorder(
                    borderRadius: BorderRadius.circular(20)),
                title: Text('SOS Alert',
                    style: GoogleFonts.poppins(
                        color: JT.textPrimary, fontWeight: FontWeight.w500)),
                content: Text(
                    'Emergency SOS send చేయాలా? Help team contact అవుతారు.',
                    style: GoogleFonts.poppins(color: JT.textSecondary)),
                actions: [
                  TextButton(
                      onPressed: () => Navigator.pop(context, false),
                      child: Text('Cancel',
                          style: GoogleFonts.poppins(color: JT.textSecondary))),
                  ElevatedButton(
                      style:
                          ElevatedButton.styleFrom(backgroundColor: JT.error),
                      onPressed: () => Navigator.pop(context, true),
                      child: const Text('SOS పంపు',
                          style: TextStyle(
                              color: Colors.white,
                              fontWeight: FontWeight.w500))),
                ]));
    if (confirm != true) return;
    final h = await AuthService.getHeaders();
    final tripId = _trip?['id'] ?? _trip?['tripId'] ?? '';
    try {
      await http.post(Uri.parse(ApiConfig.sos),
          headers: {...h, 'Content-Type': 'application/json'},
          body: jsonEncode({
            'tripId': tripId,
            'lat': _center.latitude,
            'lng': _center.longitude,
            'message': 'Driver SOS alert during trip'
          }));
      if (!mounted) return;
      _showSnack('SOS Alert sent! Help is on the way.');
    } catch (_) {
      if (!mounted) return;
      _showSnack('SOS send failed. Call 100 immediately!', error: true);
    }
  }

  void _showSnack(String msg, {bool error = false}) {
    if (!mounted) return;
    ScaffoldMessenger.of(context).showSnackBar(SnackBar(
      content: Text(msg,
          style: const TextStyle(
              fontWeight: FontWeight.w400, color: Colors.white)),
      backgroundColor: error ? JT.error : JT.primary,
      behavior: SnackBarBehavior.floating,
      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12)),
    ));
  }

  // ── Build ─────────────────────────────────────────────────────────────────

  @override
  Widget build(BuildContext context) {
    final customerName =
        _trip?['customerName'] ?? _trip?['customer_name'] ?? 'Customer';
    final customerPhone = _trip?['customerPhone'] ?? _trip?['customer_phone'];
    final pickup = _shortLocation((_trip?['pickupShortName'] ??
            _trip?['pickupAddress'] ??
            _trip?['pickup_address'] ??
            'Pickup')
        .toString());
    final dest = _shortLocation((_trip?['destinationShortName'] ??
            _trip?['destinationAddress'] ??
            _trip?['destination_address'] ??
            'Destination')
        .toString());
    final isParcel = (_trip?['type'] ?? _trip?['tripType'] ?? '')
            .toString()
            .toLowerCase()
            .contains('parcel') ||
        (_trip?['notes']?.toString().startsWith('📦') ?? false);
    final isForSomeoneElse = _trip?['isForSomeoneElse'] == true ||
        _trip?['is_for_someone_else'] == true;
    final passengerName =
        _trip?['passengerName'] ?? _trip?['passenger_name'] ?? '';
    final passengerPhone =
        _trip?['passengerPhone'] ?? _trip?['passenger_phone'];

    return PopScope(
      canPop: false,
      child: Scaffold(
        backgroundColor: JT.bg,
        body: Stack(children: [
          // ── Full screen map ────────────────────────────────────────────────
          Positioned.fill(
            child: GoogleMap(
              initialCameraPosition: CameraPosition(target: _center, zoom: 15),
              onMapCreated: (c) {
                _mapController = c;
                c.animateCamera(CameraUpdate.newLatLng(_center));
                _initMapMarkers();
                _focusMapOnRoute();
              },
              onCameraMoveStarted: () {
                _autoFollowDriver = false;
              },
              markers: _markers,
              polylines: _polylines,
              myLocationEnabled: true,
              myLocationButtonEnabled: false,
              zoomControlsEnabled: false,
              mapToolbarEnabled: false,
              compassEnabled: false,
              padding: const EdgeInsets.only(bottom: 260, top: 100),
            ),
          ),

          // ── Top status bar ─────────────────────────────────────────────────
          Positioned(
            top: 0,
            left: 0,
            right: 0,
            child: SafeArea(
              bottom: false,
              child: Padding(
                padding: const EdgeInsets.fromLTRB(16, 10, 16, 0),
                child: Column(
                  children: [
                    _buildTopBar(pickup, dest),
                    const SizedBox(height: 10),
                    _buildNavigationInstructions(),
                  ],
                ),
              ),
            ),
          ),

          // ── Bottom action sheet ────────────────────────────────────────────
          Positioned(
            bottom: 0,
            left: 0,
            right: 0,
            child: Container(
              decoration: BoxDecoration(
                color: Colors.white,
                borderRadius:
                    const BorderRadius.vertical(top: Radius.circular(28)),
                boxShadow: [
                  BoxShadow(
                      color: Colors.black.withValues(alpha: 0.10),
                      blurRadius: 24)
                ],
              ),
              child: Column(mainAxisSize: MainAxisSize.min, children: [
                Container(
                    width: 44,
                    height: 4,
                    margin: const EdgeInsets.only(top: 10, bottom: 4),
                    decoration: BoxDecoration(
                        color: JT.border,
                        borderRadius: BorderRadius.circular(2))),
                Padding(
                  padding: const EdgeInsets.fromLTRB(20, 8, 20, 28),
                  child: Column(mainAxisSize: MainAxisSize.min, children: [
                    _buildCustomerCard(customerName, customerPhone),
                    if (isForSomeoneElse &&
                        passengerName.toString().isNotEmpty) ...[
                      const SizedBox(height: 8),
                      _buildPassengerCard(
                          passengerName.toString(), passengerPhone?.toString()),
                    ],
                    if (isParcel && _trip?['notes'] != null) ...[
                      const SizedBox(height: 8),
                      _buildParcelCard(_trip!['notes'].toString()),
                    ],
                    const SizedBox(height: 10),
                    _buildLiveStats(),
                    const SizedBox(height: 8),
                    _buildPaymentBadge(),
                    if ((_status == 'in_progress' || _status == 'on_the_way') &&
                        isParcel) ...[
                      const SizedBox(height: 6),
                      _buildDeliveryOtpBtn(),
                    ],
                    _buildActionBtn(),
                    const SizedBox(height: 8),
                    _buildQuickActions(customerPhone?.toString()),
                  ]),
                ),
              ]),
            ),
          ),
        ]),
      ),
    );
  }

  // ── Top bar ───────────────────────────────────────────────────────────────

  Widget _buildTopBar(String pickup, String dest) {
    final stepInfo = _getStepInfo();
    final isOnTheWay = _status == 'in_progress' || _status == 'on_the_way';
    final isArrived = _status == 'arrived';
    final Color barColor = isOnTheWay
        ? JT.success
        : isArrived
            ? JT.warning
            : JT.primary;

    return Container(
      padding: const EdgeInsets.all(14),
      decoration: BoxDecoration(
        gradient: LinearGradient(
          colors: [Colors.white, JT.bgSoft.withValues(alpha: 0.9)],
          begin: Alignment.topCenter,
          end: Alignment.bottomCenter,
        ),
        borderRadius: BorderRadius.circular(22),
        boxShadow: [
          BoxShadow(
              color: Colors.black.withValues(alpha: 0.08),
              blurRadius: 15,
              offset: const Offset(0, 4)),
          BoxShadow(
              color: barColor.withValues(alpha: 0.1),
              blurRadius: 1,
              spreadRadius: 1),
        ],
        border: Border.all(color: barColor.withValues(alpha: 0.15), width: 1.5),
      ),
      child: Row(children: [
        Container(
            padding: const EdgeInsets.all(10),
            decoration: BoxDecoration(
                color: barColor.withValues(alpha: 0.10),
                borderRadius: BorderRadius.circular(14)),
            child:
                Icon(stepInfo['icon'] as IconData, color: barColor, size: 24)),
        const SizedBox(width: 12),
        Expanded(
            child:
                Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Text(stepInfo['label'] as String,
              style: GoogleFonts.poppins(
                  color: barColor, fontSize: 14, fontWeight: FontWeight.w400)),
          const SizedBox(height: 2),
          Text(isOnTheWay ? dest : pickup,
              style: GoogleFonts.poppins(color: JT.textSecondary, fontSize: 11),
              maxLines: 1,
              overflow: TextOverflow.ellipsis),
        ])),
        // LIVE indicator
        AnimatedBuilder(
          animation: _pulseCtrl,
          builder: (_, __) => Container(
              padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
              decoration: BoxDecoration(
                color: JT.success
                    .withValues(alpha: 0.08 + _pulseCtrl.value * 0.06),
                borderRadius: BorderRadius.circular(20),
              ),
              child: Row(mainAxisSize: MainAxisSize.min, children: [
                Container(
                    width: 7,
                    height: 7,
                    decoration: const BoxDecoration(
                        color: JT.success, shape: BoxShape.circle)),
                const SizedBox(width: 4),
                Text('LIVE',
                    style: GoogleFonts.poppins(
                        color: JT.success,
                        fontSize: 9,
                        fontWeight: FontWeight.w400)),
              ])),
        ),
      ]),
    );
  }

  Widget _buildNavigationInstructions() {
    final isOnTheWay = _status == 'in_progress' || _status == 'on_the_way';
    if (_status == 'arrived') return const SizedBox.shrink();

    final Color accentColor = _isRerouting
        ? JT.warning
        : _isOffRoute
            ? JT.error
            : (isOnTheWay ? JT.success : JT.primary);
    final String instruction = _navInstruction;
    final Color glowColor = _isOffRoute ? JT.error : accentColor;

    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 14),
      decoration: BoxDecoration(
        gradient: LinearGradient(
          colors: [
            accentColor,
            accentColor.withValues(alpha: 0.86),
            const Color(0xFF0F172A),
          ],
          begin: Alignment.topLeft,
          end: Alignment.bottomRight,
        ),
        borderRadius: BorderRadius.circular(22),
        border: Border.all(
          color: Colors.white.withValues(alpha: 0.18),
          width: 1.2,
        ),
        boxShadow: [
          BoxShadow(
            color: glowColor.withValues(alpha: 0.30),
            blurRadius: 22,
            offset: const Offset(0, 10),
          ),
          BoxShadow(
            color: Colors.black.withValues(alpha: 0.14),
            blurRadius: 10,
            offset: const Offset(0, 4),
          ),
        ],
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Container(
                width: 44,
                height: 44,
                decoration: BoxDecoration(
                  color: Colors.white.withValues(alpha: 0.16),
                  borderRadius: BorderRadius.circular(14),
                  border: Border.all(
                    color: Colors.white.withValues(alpha: 0.12),
                  ),
                ),
                child: const Icon(
                  Icons.navigation_rounded,
                  color: Colors.white,
                  size: 24,
                ),
              ),
              const SizedBox(width: 12),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      _isRerouting
                          ? 'Live Navigation Recalculating'
                          : _isOffRoute
                              ? 'Live Navigation Alert'
                              : 'Live Navigation',
                      style: GoogleFonts.poppins(
                        color: Colors.white.withValues(alpha: 0.82),
                        fontSize: 10,
                        fontWeight: FontWeight.w600,
                        letterSpacing: 0.8,
                      ),
                    ),
                    const SizedBox(height: 2),
                    Text(
                      instruction,
                      style: GoogleFonts.poppins(
                          color: Colors.white,
                          fontSize: 16,
                          fontWeight: FontWeight.w600,
                          height: 1.12),
                      maxLines: 2,
                      overflow: TextOverflow.ellipsis,
                    ),
                  ],
                ),
              ),
              GestureDetector(
                onTap: () {
                  setState(() => _navMuted = !_navMuted);
                },
                child: Container(
                  padding: const EdgeInsets.all(9),
                  decoration: BoxDecoration(
                    color: Colors.black.withValues(alpha: 0.18),
                    borderRadius: BorderRadius.circular(12),
                    border: Border.all(
                      color: Colors.white.withValues(alpha: 0.12),
                    ),
                  ),
                  child: Icon(
                    _navMuted
                        ? Icons.volume_off_rounded
                        : Icons.volume_up_rounded,
                    color: Colors.white,
                    size: 18,
                  ),
                ),
              ),
            ],
          ),
          const SizedBox(height: 12),
          Container(
            padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
            decoration: BoxDecoration(
              color: Colors.white.withValues(alpha: 0.10),
              borderRadius: BorderRadius.circular(16),
              border: Border.all(color: Colors.white.withValues(alpha: 0.10)),
            ),
            child: Row(
              children: [
                Expanded(
                  child: Text(
                    _navSecondaryInstruction.isNotEmpty
                        ? _navSecondaryInstruction
                        : (_etaSec > 0
                            ? 'EST. ARRIVAL: ${_formatEta(_etaSec)}'
                            : 'FOLLOW THE ROUTE'),
                    style: GoogleFonts.poppins(
                        color: Colors.white70,
                        fontSize: 11,
                        fontWeight: FontWeight.w500),
                    maxLines: 2,
                    overflow: TextOverflow.ellipsis,
                  ),
                ),
                const SizedBox(width: 10),
                if (_distanceToTargetM > 0)
                  Container(
                    padding:
                        const EdgeInsets.symmetric(horizontal: 10, vertical: 6),
                    decoration: BoxDecoration(
                        color: Colors.black.withValues(alpha: 0.18),
                        borderRadius: BorderRadius.circular(10)),
                    child: Text(
                      _formatDist(_distanceToTargetM),
                      style: const TextStyle(
                          color: Colors.white,
                          fontWeight: FontWeight.w700,
                          fontSize: 13),
                    ),
                  ),
              ],
            ),
          ),
          const SizedBox(height: 10),
          Wrap(
            spacing: 8,
            runSpacing: 8,
            children: [
              _navInfoChip(
                icon: Icons.route_rounded,
                label: _navSteps.isNotEmpty
                    ? 'Step ${_navStepIndex + 1}/${_navSteps.length}'
                    : 'Route ready',
              ),
              _navInfoChip(
                icon: _isRerouting
                    ? Icons.sync_rounded
                    : _isOffRoute
                        ? Icons.warning_amber_rounded
                        : Icons.access_time_filled_rounded,
                label: _isRerouting
                    ? 'Rerouting now'
                    : _isOffRoute
                        ? 'Off route'
                        : (_etaSec > 0 ? _formatEta(_etaSec) : 'Tracking live'),
              ),
            ],
          ),
        ],
      ),
    );
  }

  Widget _navInfoChip({required IconData icon, required String label}) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 7),
      decoration: BoxDecoration(
        color: Colors.black.withValues(alpha: 0.16),
        borderRadius: BorderRadius.circular(999),
        border: Border.all(color: Colors.white.withValues(alpha: 0.10)),
      ),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          Icon(icon, color: Colors.white, size: 14),
          const SizedBox(width: 6),
          Text(
            label,
            style: GoogleFonts.poppins(
              color: Colors.white,
              fontSize: 11,
              fontWeight: FontWeight.w500,
            ),
          ),
        ],
      ),
    );
  }

  // ── Customer card ─────────────────────────────────────────────────────────

  Widget _buildCustomerCard(String name, String? phone) {
    final pm = _trip?['paymentMethod'] ?? _trip?['payment_method'] ?? 'cash';
    final pmLabel = pm == 'wallet'
        ? 'Wallet'
        : (pm == 'upi' || pm == 'online' || pm == 'razorpay')
            ? 'UPI'
            : 'Cash';
    final pmColor = pm == 'wallet'
        ? JT.primary
        : (pm == 'upi' || pm == 'online' || pm == 'razorpay')
            ? JT.secondary
            : JT.success;
    final fare = double.tryParse(
            (_trip?['estimatedFare'] ?? _trip?['estimated_fare'] ?? 0)
                .toString()) ??
        0;

    return Container(
      decoration: BoxDecoration(
          gradient: LinearGradient(
            colors: [
              Colors.white,
              JT.bgSoft,
              JT.primary.withValues(alpha: 0.05),
            ],
            begin: Alignment.topLeft,
            end: Alignment.bottomRight,
          ),
          borderRadius: BorderRadius.circular(22),
          border: Border.all(color: JT.primary.withValues(alpha: 0.10)),
          boxShadow: [
            ...JT.cardShadow,
            BoxShadow(
              color: JT.primary.withValues(alpha: 0.06),
              blurRadius: 18,
              offset: const Offset(0, 8),
            ),
          ]),
      child: Column(children: [
        Padding(
          padding: const EdgeInsets.all(16),
          child: Row(children: [
            Container(
                width: 52,
                height: 52,
                decoration: BoxDecoration(
                    gradient: JT.grad,
                    borderRadius: BorderRadius.circular(18),
                    boxShadow: JT.btnShadow),
                child: Center(
                    child: Text(name.isNotEmpty ? name[0].toUpperCase() : 'C',
                        style: const TextStyle(
                            color: Colors.white,
                            fontSize: 22,
                            fontWeight: FontWeight.w500)))),
            const SizedBox(width: 12),
            Expanded(
                child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                  Text('Rider',
                      style: GoogleFonts.poppins(
                          color: JT.textSecondary,
                          fontSize: 10,
                          fontWeight: FontWeight.w600,
                          letterSpacing: 0.7)),
                  const SizedBox(height: 1),
                  Text(name,
                      style: GoogleFonts.poppins(
                          color: JT.textPrimary,
                          fontSize: 16,
                          fontWeight: FontWeight.w600),
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis),
                  const SizedBox(height: 3),
                  Container(
                    padding:
                        const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
                    decoration: BoxDecoration(
                      color: pmColor.withValues(alpha: 0.10),
                      borderRadius: BorderRadius.circular(999),
                    ),
                    child: Text(pmLabel,
                        style: GoogleFonts.poppins(
                            color: pmColor,
                            fontSize: 11,
                            fontWeight: FontWeight.w600)),
                  ),
                ])),
            if (phone != null)
              GestureDetector(
                  onTap: () => _startInAppCall(name),
                  child: Container(
                      width: 48,
                      height: 48,
                      decoration: BoxDecoration(
                          color: Colors.white,
                          border: Border.all(color: JT.primary.withValues(alpha: 0.14)),
                          borderRadius: BorderRadius.circular(16),
                          boxShadow: JT.cardShadow),
                      child: const Icon(Icons.phone_rounded,
                          color: JT.primary, size: 20))),
          ]),
        ),
        Container(
          height: 1,
          margin: const EdgeInsets.symmetric(horizontal: 14),
          color: JT.border,
        ),
        Padding(
          padding: const EdgeInsets.fromLTRB(14, 12, 14, 12),
          child: Row(children: [
            Expanded(
                child: _pill(
                    'Fare', fare > 0 ? '₹${fare.toInt()}' : '₹--', JT.success)),
            const SizedBox(width: 6),
            Expanded(
                child: _pill(
                    'Distance',
                    (double.tryParse((_trip?['estimatedDistance'] ?? 0)
                                    .toString()) ??
                                0) >
                            0
                        ? '${(double.parse(_trip!['estimatedDistance'].toString())).toStringAsFixed(1)} km'
                        : '--',
                    JT.primary)),
            const SizedBox(width: 6),
            Expanded(child: _pill('Pay', pmLabel, pmColor)),
          ]),
        ),
      ]),
    );
  }

  Widget _pill(String label, String value, Color color) => Container(
      padding: const EdgeInsets.symmetric(vertical: 10, horizontal: 8),
      decoration: BoxDecoration(
          gradient: LinearGradient(
            colors: [
              Colors.white,
              color.withValues(alpha: 0.07),
            ],
            begin: Alignment.topCenter,
            end: Alignment.bottomCenter,
          ),
          borderRadius: BorderRadius.circular(14),
          border: Border.all(color: color.withValues(alpha: 0.15)),
          boxShadow: [
            BoxShadow(
              color: color.withValues(alpha: 0.06),
              blurRadius: 10,
              offset: const Offset(0, 4),
            ),
          ]),
      child: Column(children: [
        Text(value,
            style: GoogleFonts.poppins(
                color: color, fontSize: 13, fontWeight: FontWeight.w600)),
        const SizedBox(height: 3),
        Text(label,
            style: GoogleFonts.poppins(
                color: JT.textSecondary,
                fontSize: 9,
                fontWeight: FontWeight.w500)),
      ]));

  // ── Live stats (distance/ETA/timer) ───────────────────────────────────────

  Widget _buildLiveStats() {
    final isOnTheWay = _status == 'in_progress' || _status == 'on_the_way';
    final isNavigating = _status == 'accepted' || _status == 'driver_assigned';

    if (_status == 'arrived') {
      return Container(
          margin: const EdgeInsets.only(bottom: 6),
          padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 10),
          decoration: BoxDecoration(
              color: JT.warning.withValues(alpha: 0.08),
              borderRadius: BorderRadius.circular(12),
              border: Border.all(color: JT.warning.withValues(alpha: 0.3))),
          child: Row(mainAxisAlignment: MainAxisAlignment.center, children: [
            const Icon(Icons.location_on_rounded, color: JT.warning, size: 18),
            const SizedBox(width: 8),
            Text('At pickup — waiting for customer',
                style: GoogleFonts.poppins(
                    color: JT.warning,
                    fontSize: 13,
                    fontWeight: FontWeight.w500)),
          ]));
    }

    if (!isNavigating && !isOnTheWay) return const SizedBox.shrink();

    return Container(
      margin: const EdgeInsets.only(bottom: 6),
      padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 12),
      decoration: BoxDecoration(
          gradient: LinearGradient(
            colors: isOnTheWay
                ? [
                    JT.success.withValues(alpha: 0.10),
                    Colors.white,
                  ]
                : [
                    JT.primary.withValues(alpha: 0.10),
                    Colors.white,
                  ],
            begin: Alignment.topLeft,
            end: Alignment.bottomRight,
          ),
          borderRadius: BorderRadius.circular(16),
          border: Border.all(
              color:
                  isOnTheWay ? JT.success.withValues(alpha: 0.2) : JT.border)),
      child: Row(children: [
        Container(
          width: 34,
          height: 34,
          decoration: BoxDecoration(
            color: (isOnTheWay ? JT.success : JT.primary).withValues(alpha: 0.12),
            borderRadius: BorderRadius.circular(11),
          ),
          child: Icon(isOnTheWay ? Icons.speed_rounded : Icons.navigation_rounded,
              color: isOnTheWay ? JT.success : JT.primary, size: 18),
        ),
        const SizedBox(width: 10),
        Expanded(
            child: Row(children: [
          Text(_distanceToTargetM > 0 ? _formatDist(_distanceToTargetM) : '--',
              style: GoogleFonts.poppins(
                  color: isOnTheWay ? JT.success : JT.primary,
                  fontSize: 15,
                  fontWeight: FontWeight.w500)),
          const SizedBox(width: 6),
          Text('away',
              style:
                  GoogleFonts.poppins(color: JT.textSecondary, fontSize: 12)),
          const SizedBox(width: 12),
          const Icon(Icons.access_time_rounded,
              size: 13, color: JT.iconInactive),
          const SizedBox(width: 4),
          Text(_etaSec > 0 ? _formatEta(_etaSec) : '--',
              style: GoogleFonts.poppins(
                  color: JT.textSecondary,
                  fontSize: 12,
                  fontWeight: FontWeight.w400)),
        ])),
        if (isOnTheWay && _tripElapsedSec > 0)
          Container(
              padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 4),
              decoration: BoxDecoration(
                  color: JT.success.withValues(alpha: 0.12),
                  borderRadius: BorderRadius.circular(20)),
              child: Text(_formatElapsed(_tripElapsedSec),
                  style: GoogleFonts.poppins(
                      color: JT.success,
                      fontSize: 12,
                      fontWeight: FontWeight.w400))),
        if (_nearPickup && isNavigating)
          Container(
              padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 4),
              decoration: BoxDecoration(
                  color: JT.success.withValues(alpha: 0.15),
                  borderRadius: BorderRadius.circular(20),
                  border: Border.all(color: JT.success.withValues(alpha: 0.4))),
              child: Text('Near Pickup!',
                  style: GoogleFonts.poppins(
                      color: JT.success,
                      fontSize: 11,
                      fontWeight: FontWeight.w400))),
      ]),
    );
  }

  // ── Payment badge ─────────────────────────────────────────────────────────

  Widget _buildPaymentBadge() {
    final pm = _trip?['paymentMethod'] ?? _trip?['payment_method'] ?? 'cash';
    final isCash = pm == 'cash';
    final fare = double.tryParse(
            (_trip?['estimatedFare'] ?? _trip?['estimated_fare'] ?? 0)
                .toString()) ??
        0;

    if (isCash && (_status == 'in_progress' || _status == 'on_the_way')) {
      return Container(
          margin: const EdgeInsets.only(bottom: 8),
          padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 12),
          decoration: BoxDecoration(
              gradient: JT.grad,
              borderRadius: BorderRadius.circular(14),
              boxShadow: JT.btnShadow),
          child: Row(children: [
            Container(
                width: 42,
                height: 42,
                decoration: BoxDecoration(
                    color: Colors.white.withValues(alpha: 0.2),
                    borderRadius: BorderRadius.circular(11)),
                child: const Icon(Icons.payments_rounded,
                    color: Colors.white, size: 20)),
            const SizedBox(width: 12),
            Expanded(
                child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                  Text('COLLECT ₹${fare.toInt()} CASH',
                      style: const TextStyle(
                          color: Colors.white,
                          fontWeight: FontWeight.w400,
                          fontSize: 13,
                          letterSpacing: 0.5)),
                  const Text('Remind customer to have exact change',
                      style: TextStyle(color: Colors.white70, fontSize: 11)),
                ])),
          ]));
    }
    if (isCash) {
      return Container(
          margin: const EdgeInsets.only(bottom: 6),
          padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 7),
          decoration: BoxDecoration(
              color: JT.success.withValues(alpha: 0.07),
              borderRadius: BorderRadius.circular(10),
              border: Border.all(color: JT.success.withValues(alpha: 0.20))),
          child: const Row(children: [
            Icon(Icons.payments_rounded, color: JT.success, size: 14),
            SizedBox(width: 7),
            Text('Cash Payment — Collect at trip end',
                style: TextStyle(
                    color: JT.success,
                    fontSize: 11,
                    fontWeight: FontWeight.w400)),
          ]));
    }
    return Container(
        margin: const EdgeInsets.only(bottom: 6),
        padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 7),
        decoration: BoxDecoration(
            color: JT.primary.withValues(alpha: 0.05),
            borderRadius: BorderRadius.circular(10),
            border: Border.all(color: JT.border)),
        child: Row(children: [
          const Icon(Icons.account_balance_wallet_rounded,
              color: JT.primary, size: 14),
          const SizedBox(width: 7),
          Text(
              pm == 'wallet'
                  ? 'Wallet — Auto deducted'
                  : 'Online — Already paid',
              style: GoogleFonts.poppins(
                  color: JT.primary,
                  fontSize: 11,
                  fontWeight: FontWeight.w400)),
        ]));
  }

  // ── Delivery OTP button ───────────────────────────────────────────────────

  Widget _buildDeliveryOtpBtn() => GestureDetector(
      onTap: _showDeliveryOtpDialog,
      child: Container(
          padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 10),
          margin: const EdgeInsets.only(bottom: 4),
          decoration: BoxDecoration(
              color: JT.warning.withValues(alpha: 0.10),
              borderRadius: BorderRadius.circular(12),
              border: Border.all(color: JT.warning.withValues(alpha: 0.3))),
          child: Row(mainAxisAlignment: MainAxisAlignment.center, children: [
            const Icon(Icons.lock_open_rounded, color: JT.warning, size: 17),
            const SizedBox(width: 7),
            Text('Verify Delivery OTP',
                style: GoogleFonts.poppins(
                    color: JT.warning,
                    fontSize: 13,
                    fontWeight: FontWeight.w400)),
          ])));

  // ── Main action button ────────────────────────────────────────────────────

  Widget _buildActionBtn() {
    final step = _getStepInfo();
    final isOnTheWay = _status == 'in_progress' || _status == 'on_the_way';
    final showGlow =
        _nearPickup && (_status == 'accepted' || _status == 'driver_assigned');

    return GestureDetector(
      onTap: _loading ? null : _nextStep,
      child: AnimatedContainer(
        duration: const Duration(milliseconds: 300),
        width: double.infinity,
        height: 60,
        margin: const EdgeInsets.only(top: 6),
        decoration: BoxDecoration(
          gradient: isOnTheWay
              ? const LinearGradient(
                  colors: [JT.success, Color(0xFF15803D)],
                  begin: Alignment.centerLeft,
                  end: Alignment.centerRight)
              : JT.grad,
          borderRadius: BorderRadius.circular(18),
          boxShadow: [
            BoxShadow(
                color: (isOnTheWay ? JT.success : JT.primary)
                    .withValues(alpha: showGlow ? 0.55 : 0.35),
                blurRadius: showGlow ? 28 : 18,
                offset: const Offset(0, 6)),
          ],
          border: showGlow ? Border.all(color: JT.success, width: 2) : null,
        ),
        child: Center(
          child: _loading
              ? const Row(
                  mainAxisAlignment: MainAxisAlignment.center,
                  children: [
                      SizedBox(
                          width: 22,
                          height: 22,
                          child: CircularProgressIndicator(
                              color: Colors.white, strokeWidth: 2.5)),
                      SizedBox(width: 12),
                      Text('Please wait...',
                          style: TextStyle(
                              color: Colors.white,
                              fontWeight: FontWeight.w500,
                              fontSize: 14)),
                    ])
              : Row(mainAxisAlignment: MainAxisAlignment.center, children: [
                  Container(
                      width: 36,
                      height: 36,
                      decoration: BoxDecoration(
                          color: Colors.white.withValues(alpha: 0.2),
                          shape: BoxShape.circle),
                      child: Icon(step['icon'] as IconData,
                          color: Colors.white, size: 20)),
                  const SizedBox(width: 12),
                  Text(step['action'] as String,
                      style: const TextStyle(
                          color: Colors.white,
                          fontSize: 16,
                          fontWeight: FontWeight.w500,
                          letterSpacing: -0.2)),
                ]),
        ),
      ),
    );
  }

  // ── Quick action row ──────────────────────────────────────────────────────

  Widget _buildQuickActions(String? phone) {
    return Wrap(
        alignment: WrapAlignment.center,
        spacing: 8,
        runSpacing: 8,
        children: [
          if (phone != null)
            _quickBtn(Icons.phone_rounded, 'Call', JT.primary, () {
              final n = (_trip?['customerName'] ??
                      _trip?['customer_name'] ??
                      'Customer')
                  .toString();
              _startInAppCall(n);
            }),
          _quickBtn(Icons.chat_rounded, 'Chat', JT.primary, _openTripChat),
          _quickBtn(Icons.navigation_rounded, 'Navigate', JT.primary,
              _openNavigation),
          if (_status == 'accepted' ||
              _status == 'driver_assigned' ||
              _status == 'arrived')
            _quickBtn(
                Icons.cancel_outlined, 'Cancel', JT.warning, _showCancelDialog),
          _quickBtn(Icons.sos_rounded, 'SOS', JT.error, _triggerSos),
        ]);
  }

  Widget _quickBtn(
          IconData icon, String label, Color color, VoidCallback onTap) =>
      GestureDetector(
          onTap: onTap,
          child: Container(
              padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 8),
              decoration: BoxDecoration(
                  color: color.withValues(alpha: 0.06),
                  borderRadius: BorderRadius.circular(12),
                  border: Border.all(color: color.withValues(alpha: 0.22))),
              child: Row(mainAxisSize: MainAxisSize.min, children: [
                Icon(icon, color: color, size: 15),
                const SizedBox(width: 5),
                Text(label,
                    style: GoogleFonts.poppins(
                        color: color,
                        fontSize: 12,
                        fontWeight: FontWeight.w500)),
              ])));

  // ── Parcel card ───────────────────────────────────────────────────────────

  Widget _buildParcelCard(String notes) {
    String receiver = '', category = '', weight = '', instructions = '';
    for (final part in notes.split(' | ')) {
      if (part.startsWith('Category:'))
        category = part.replaceFirst('Category: ', '');
      if (part.startsWith('Weight:'))
        weight = part.replaceFirst('Weight: ', '');
      if (part.startsWith('Receiver:'))
        receiver = part.replaceFirst('Receiver: ', '');
      if (part.startsWith('Instructions:') && !part.contains('None'))
        instructions = part.replaceFirst('Instructions: ', '');
    }
    return Container(
        padding: const EdgeInsets.all(12),
        decoration: BoxDecoration(
            color: JT.warning.withValues(alpha: 0.06),
            borderRadius: BorderRadius.circular(14),
            border: Border.all(color: JT.warning.withValues(alpha: 0.25))),
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Row(children: [
            const Text('📦', style: TextStyle(fontSize: 15)),
            const SizedBox(width: 7),
            Text('PARCEL',
                style: GoogleFonts.poppins(
                    color: JT.warning,
                    fontSize: 10,
                    fontWeight: FontWeight.w400,
                    letterSpacing: 1)),
          ]),
          if (receiver.isNotEmpty) ...[
            const SizedBox(height: 6),
            Row(children: [
              const Icon(Icons.person_rounded, color: JT.warning, size: 14),
              const SizedBox(width: 5),
              Expanded(
                  child: Text(receiver,
                      style: GoogleFonts.poppins(
                          color: JT.textSecondary,
                          fontSize: 12,
                          fontWeight: FontWeight.w400)))
            ]),
          ],
          if (category.isNotEmpty) ...[
            const SizedBox(height: 3),
            Text('$category  •  $weight',
                style:
                    GoogleFonts.poppins(color: JT.textSecondary, fontSize: 11)),
          ],
          if (instructions.isNotEmpty) ...[
            const SizedBox(height: 3),
            Text(instructions,
                style:
                    GoogleFonts.poppins(color: JT.textSecondary, fontSize: 11)),
          ],
        ]));
  }

  // ── Passenger card ────────────────────────────────────────────────────────

  Widget _buildPassengerCard(String passengerName, String? passengerPhone) =>
      Container(
          padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
          decoration: BoxDecoration(
              color: JT.surfaceAlt,
              borderRadius: BorderRadius.circular(12),
              border: Border.all(color: JT.border)),
          child: Row(children: [
            Container(
                padding: const EdgeInsets.all(8),
                decoration: BoxDecoration(
                    color: JT.primary.withValues(alpha: 0.10),
                    borderRadius: BorderRadius.circular(10)),
                child: const Icon(Icons.person_pin_rounded,
                    color: JT.primary, size: 17)),
            const SizedBox(width: 10),
            Expanded(
                child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                  Text('PASSENGER',
                      style: GoogleFonts.poppins(
                          color: JT.primary,
                          fontSize: 9,
                          fontWeight: FontWeight.w400,
                          letterSpacing: 1)),
                  Text(passengerName,
                      style: GoogleFonts.poppins(
                          color: JT.textPrimary,
                          fontSize: 13,
                          fontWeight: FontWeight.w500)),
                  if (passengerPhone != null && passengerPhone.isNotEmpty)
                    Text(passengerPhone,
                        style: GoogleFonts.poppins(
                            color: JT.textSecondary, fontSize: 11)),
                ])),
          ]));

  // ── Step info ─────────────────────────────────────────────────────────────

  Map<String, dynamic> _getStepInfo() {
    switch (_status) {
      case 'driver_assigned':
      case 'accepted':
        return {
          'label': 'Navigating to Pickup',
          'icon': Icons.navigation_rounded,
          'action': 'Arrived at Pickup'
        };
      case 'arrived':
        return {
          'label': 'Arrived — Enter OTP to Start',
          'icon': Icons.lock_open_rounded,
          'action': 'Enter Customer OTP'
        };
      case 'in_progress':
      case 'on_the_way':
        return {
          'label': 'Trip in Progress',
          'icon': Icons.speed_rounded,
          'action': 'Complete Trip ✓'
        };
      default:
        return {
          'label': 'Trip Active',
          'icon': Icons.electric_bike,
          'action': 'Next Step'
        };
    }
  }
}
