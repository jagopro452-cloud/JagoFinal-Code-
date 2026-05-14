import 'dart:async';
import 'dart:convert';
import 'dart:ui' as ui;
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:geolocator/geolocator.dart';
import 'package:google_fonts/google_fonts.dart';
import 'package:google_maps_flutter/google_maps_flutter.dart';
import 'package:http/http.dart' as http;
import 'package:shared_preferences/shared_preferences.dart';
import '../../config/api_config.dart';
import '../../config/jago_theme.dart';
import '../../services/auth_service.dart';
import '../../services/socket_service.dart';
import '../history/trips_history_screen.dart';
import '../wallet/wallet_screen.dart';
import '../profile/profile_screen.dart';
import '../booking/booking_screen.dart';
import '../booking/map_location_picker.dart';
import '../tracking/tracking_screen.dart';
import '../booking/intercity_booking_screen.dart';
import '../offers/offers_screen.dart';
import '../profile/support_chat_screen.dart';
import '../referral/referral_screen.dart';
import '../saved_places/saved_places_screen.dart';
import '../booking/parcel_booking_screen.dart';
import '../booking/location_screen.dart';
import '../booking/premium_location_screen.dart';
import '../../services/trip_service.dart';
import '../auth/login_screen.dart';
import '../b2b/b2b_login_screen.dart';
import '../outstation_pool/outstation_pool_screen.dart';

class HomeScreen extends StatefulWidget {
  const HomeScreen({super.key});
  @override
  State<HomeScreen> createState() => _HomeScreenState();
}

class _HomeScreenState extends State<HomeScreen> with WidgetsBindingObserver {
  final GlobalKey<ScaffoldState> _scaffoldKey = GlobalKey<ScaffoldState>();
  final SocketService _socket = SocketService();

  String _userName = 'there';
  String _userPhone = '';
  String _pickup = 'Getting location...';
  double _pickupLat = 0.0, _pickupLng = 0.0;
  bool _locationReady = false;
  List<Map<String, dynamic>> _vehicleCategories = [];
  List<dynamic> _savedPlaces = [];
  List<Map<String, dynamic>> _recentTrips = [];
  Map<String, dynamic>? _activeTrip;
  StreamSubscription? _driverAssignedSub;
  StreamSubscription? _tripCancelledSub;
  StreamSubscription? _tripStatusSub;
  Timer? _searchingTimer; // auto-cancel if no pilot found within 5 min
  Timer?
      _statePollTimer; // 5s poll during searching — server is source of truth
  bool _homeLoading = true;
  Timer? _loadingTimeout;

  // New state: banners + feature flags
  List<Map<String, dynamic>> _banners = [];
  int _bannerIndex = 0;
  Timer? _bannerTimer;
  final PageController _bannerPageCtrl = PageController();

  // ── Live Map state ────────────────────────────────────────────────────────
  GoogleMapController? _mapController;
  Timer? _nearbyDriversTimer;
  final Map<String, BitmapDescriptor> _markerIconCache = {};

  // Brand colors — mapped to JT design system
  static const Color _darkBg = JT.textPrimary;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    _loadUser();
    _getLocation();
    _fetchHome();
    _loadSavedPlaces();
    _loadRecentTrips();
    _fetchBanners();
    _fetchFeatureFlags();
    _connectSocket();
    // Safety fallback: never show loading more than 6 seconds
    _loadingTimeout = Timer(const Duration(seconds: 6), () {
      if (mounted && _homeLoading) setState(() => _homeLoading = false);
    });
    // Auto-scroll banner every 4 seconds
    _bannerTimer = Timer.periodic(const Duration(seconds: 4), (_) {
      if (!mounted || _banners.isEmpty) return;
      final next = (_bannerIndex + 1) % _banners.length;
      _bannerPageCtrl.animateToPage(next,
          duration: const Duration(milliseconds: 400), curve: Curves.easeInOut);
    });
    WidgetsBinding.instance
        .addPostFrameCallback((_) => _checkPendingFcmNotification());
    WidgetsBinding.instance.addPostFrameCallback((_) => _checkActiveTrip());
    WidgetsBinding.instance.addPostFrameCallback((_) => _maybeShowTutorial());
    // Start nearby drivers polling (10s — battery-optimised, still smooth enough)
    _nearbyDriversTimer = Timer.periodic(
        const Duration(seconds: 10), (_) => _fetchNearbyDrivers());
    _fetchNearbyDrivers(); // fetch immediately
  }

  Future<void> _loadSavedPlaces() async {
    try {
      final places = await TripService.getSavedPlaces();
      if (mounted)
        setState(() => _savedPlaces = places
            .where((p) => p['label'] == 'Home' || p['label'] == 'Work')
            .toList());
    } catch (_) {}
  }

  Future<void> _loadRecentTrips() async {
    try {
      final headers = await AuthService.getHeaders();
      final r = await http.get(
          Uri.parse(
              '${ApiConfig.baseUrl}/api/app/customer/trips?limit=3&status=completed'),
          headers: headers);
      if (r.statusCode == 200 && mounted) {
        final data = jsonDecode(r.body);
        final trips =
            (data['trips'] as List<dynamic>?)?.cast<Map<String, dynamic>>() ??
                [];
        setState(() => _recentTrips = trips);
      }
    } catch (_) {}
  }

  Future<void> _fetchBanners() async {
    try {
      final headers = await AuthService.getHeaders();
      final r = await http
          .get(Uri.parse('${ApiConfig.baseUrl}/api/app/banners'),
              headers: headers)
          .timeout(const Duration(seconds: 6));
      if (r.statusCode == 200 && mounted) {
        final data = jsonDecode(r.body) as Map<String, dynamic>;
        final list =
            (data['banners'] as List<dynamic>?)?.cast<Map<String, dynamic>>() ??
                [];
        setState(() => _banners = list);
      }
    } catch (_) {}
  }

  Future<void> _fetchFeatureFlags() async {
    try {
      final r = await http
          .get(Uri.parse('${ApiConfig.baseUrl}/api/app/feature-flags'))
          .timeout(const Duration(seconds: 6));
      if (r.statusCode == 200 && mounted) {
        // feature flags loaded (unused by current UI)
      }
    } catch (_) {}
  }

  // ── LIVE MAP: Nearby Drivers ─────────────────────────────────────────────

  Future<BitmapDescriptor> _getVehicleMarkerIcon(String vehicleType) async {
    if (_markerIconCache.containsKey(vehicleType))
      return _markerIconCache[vehicleType]!;
    final descriptor = await _drawVehicleMarker(vehicleType);
    _markerIconCache[vehicleType] = descriptor;
    return descriptor;
  }

  Future<BitmapDescriptor> _drawVehicleMarker(String vehicleType) async {
    const size = 72.0;
    final recorder = ui.PictureRecorder();
    final canvas = Canvas(recorder, Rect.fromLTWH(0, 0, size, size));

    // Pick color + emoji by vehicle type
    Color bg;
    String emoji;
    if (vehicleType.contains('bike') || vehicleType.contains('moto')) {
      bg = const Color(0xFF2F7BFF);
      emoji = '🏍️';
    } else if (vehicleType.contains('auto')) {
      bg = const Color(0xFF5B9DFF);
      emoji = '🛺';
    } else if (vehicleType.contains('parcel') ||
        vehicleType.contains('cargo')) {
      bg = const Color(0xFF1A6FDB);
      emoji = '📦';
    } else {
      bg = const Color(0xFF2563EB);
      emoji = '🚗';
    }

    // Shadow
    final shadowPaint = Paint()
      ..color = bg.withValues(alpha: 0.35)
      ..maskFilter = const MaskFilter.blur(BlurStyle.normal, 6);
    canvas.drawCircle(
        const Offset(size / 2, size / 2 + 2), size / 2 - 6, shadowPaint);

    // Circle background
    canvas.drawCircle(
        const Offset(size / 2, size / 2), size / 2 - 8, Paint()..color = bg);

    // White border
    canvas.drawCircle(
      const Offset(size / 2, size / 2),
      size / 2 - 8,
      Paint()
        ..color = Colors.white
        ..style = PaintingStyle.stroke
        ..strokeWidth = 3,
    );

    // Emoji
    final tp = TextPainter(
      text: TextSpan(text: emoji, style: const TextStyle(fontSize: 26)),
      textDirection: TextDirection.ltr,
    )..layout();
    tp.paint(canvas, Offset((size - tp.width) / 2, (size - tp.height) / 2 - 1));

    final picture = recorder.endRecording();
    final img = await picture.toImage(size.toInt(), size.toInt());
    final data = await img.toByteData(format: ui.ImageByteFormat.png);
    return BitmapDescriptor.bytes(data!.buffer.asUint8List());
  }

  Future<void> _fetchNearbyDrivers() async {
    if (!mounted || !_locationReady) return;
    try {
      final headers = await AuthService.getHeaders();
      final uri = Uri.parse(ApiConfig.nearbyDrivers).replace(queryParameters: {
        'lat': _pickupLat.toString(),
        'lng': _pickupLng.toString(),
        'radius': '5',
      });
      final r = await http
          .get(uri, headers: headers)
          .timeout(const Duration(seconds: 5));
      if (!mounted || r.statusCode != 200) return;

      final data = jsonDecode(r.body) as Map<String, dynamic>;
      final drivers =
          (data['drivers'] as List<dynamic>?)?.cast<Map<String, dynamic>>() ??
              [];

      final Set<Marker> newMarkers = {};
      for (final d in drivers) {
        final lat = double.tryParse(d['lat']?.toString() ?? '');
        final lng = double.tryParse(d['lng']?.toString() ?? '');
        if (lat == null || lng == null) continue;

        final id = d['id']?.toString() ?? '';
        final vehicleType =
            (d['vehicleCategoryName'] ?? d['vehicleName'] ?? 'car')
                .toString()
                .toLowerCase();
        final heading = double.tryParse(d['heading']?.toString() ?? '0') ?? 0;
        final rating = double.tryParse(d['rating']?.toString() ?? '0') ?? 0;

        final icon = await _getVehicleMarkerIcon(vehicleType);

        newMarkers.add(Marker(
          markerId: MarkerId('driver_$id'),
          position: LatLng(lat, lng),
          icon: icon,
          rotation: heading,
          anchor: const Offset(0.5, 0.5),
          flat: true, // rotates with map
          infoWindow: InfoWindow(
            title: d['fullName']?.toString() ?? 'Driver',
            snippet: rating > 0 ? '⭐ ${rating.toStringAsFixed(1)}' : null,
          ),
        ));
      }

      if (!mounted) return;
    } catch (_) {}
  }

  Future<void> _checkPendingFcmNotification() async {
    try {
      final prefs = await SharedPreferences.getInstance();
      final pendingStr = prefs.getString('pending_notification');
      if (pendingStr != null && pendingStr.isNotEmpty) {
        await prefs.remove('pending_notification');
        final data = jsonDecode(pendingStr) as Map<String, dynamic>;
        final type = data['type']?.toString() ?? '';
        final tripId = data['tripId']?.toString() ?? '';
        if (!mounted || tripId.isEmpty) return;
        if (type == 'trip_accepted' ||
            type == 'driver_assigned' ||
            type == 'driver_arrived') {
          // Verify trip is still active — prevents stale FCM from causing blank screen
          try {
            final verifyHeaders = await AuthService.getHeaders();
            final tripCheck = await http.get(Uri.parse(ApiConfig.activeTrip),
                headers: verifyHeaders);
            if (tripCheck.statusCode == 200) {
              final td = jsonDecode(tripCheck.body);
              final activeT = td['trip'] as Map<String, dynamic>?;
              if (activeT == null) return;
              final st = activeT['currentStatus']?.toString() ?? '';
              if (st == 'completed' || st == 'cancelled' || st.isEmpty) return;
            } else {
              return;
            }
          } catch (_) {
            return;
          }
          if (!mounted) return;
          Navigator.pushReplacement(
              context,
              MaterialPageRoute(
                  builder: (_) => TrackingScreen(tripId: tripId)));
        }
      }
    } catch (_) {}
  }

  Future<void> _checkActiveTrip() async {
    try {
      final headers = await AuthService.getHeaders();
      final r =
          await http.get(Uri.parse(ApiConfig.activeTrip), headers: headers);
      if (!mounted) return;
      if (r.statusCode == 401) {
        _handleUnauthorized();
        return;
      }
      if (r.statusCode == 200) {
        final data = jsonDecode(r.body);
        final trip = data['trip'] as Map<String, dynamic>?;
        if (trip != null) {
          final status = trip['currentStatus']?.toString() ?? '';
          if (status != 'completed' && status != 'cancelled') {
            setState(() => _activeTrip = trip);
            // Start auto-cancel timer if searching and no pilot found yet
            if (status == 'searching') {
              _startSearchingTimer(trip['id']?.toString() ?? '');
            }
            // Fix 7: if driver already assigned/in-progress, go straight to TrackingScreen
            if (['accepted', 'arrived', 'on_the_way', 'driver_assigned']
                .contains(status)) {
              final tripId = trip['id']?.toString() ?? '';
              if (tripId.isNotEmpty && mounted) {
                Navigator.pushReplacement(
                  context,
                  MaterialPageRoute(
                    builder: (_) => TrackingScreen(tripId: tripId),
                  ),
                );
              }
            }
          }
        }
      }
    } catch (_) {}
  }

  void _startSearchingTimer(String tripId) {
    _searchingTimer?.cancel();
    // Auto-cancel after 5 minutes if still searching
    _searchingTimer =
        Timer(const Duration(minutes: 5), () => _autoCancelSearching(tripId));
    // Poll server every 5s while searching — catches driver acceptance when socket is down
    _statePollTimer?.cancel();
    _statePollTimer =
        Timer.periodic(const Duration(seconds: 5), (_) => _pollTripState());
  }

  Future<void> _pollTripState() async {
    if (!mounted || _activeTrip == null) {
      _statePollTimer?.cancel();
      return;
    }
    try {
      final headers = await AuthService.getHeaders();
      final r = await http
          .get(Uri.parse(ApiConfig.activeTrip), headers: headers)
          .timeout(const Duration(seconds: 4));
      if (!mounted) return;
      if (r.statusCode == 200) {
        final data = jsonDecode(r.body);
        final trip = data['trip'] as Map<String, dynamic>?;
        if (trip == null) {
          // Trip gone — cancelled or completed
          _statePollTimer?.cancel();
          _searchingTimer?.cancel();
          setState(() => _activeTrip = null);
          return;
        }
        final status = trip['currentStatus']?.toString() ?? '';
        if (status == 'completed' || status == 'cancelled') {
          _statePollTimer?.cancel();
          _searchingTimer?.cancel();
          setState(() => _activeTrip = null);
          return;
        }
        setState(() => _activeTrip = trip);
        // Driver accepted while socket was down → navigate to tracking
        if (['accepted', 'arrived', 'on_the_way', 'driver_assigned']
            .contains(status)) {
          _statePollTimer?.cancel();
          _searchingTimer?.cancel();
          final tripId = trip['id']?.toString() ?? '';
          if (tripId.isNotEmpty && mounted) {
            Navigator.pushReplacement(
                context,
                MaterialPageRoute(
                    builder: (_) => TrackingScreen(tripId: tripId)));
          }
        }
      }
    } catch (_) {} // network error — keep polling
  }

  Future<void> _autoCancelSearching(String tripId) async {
    if (!mounted || _activeTrip == null) return;
    final status = _activeTrip!['currentStatus']?.toString() ?? '';
    if (status != 'searching') return;
    try {
      final h = await AuthService.getHeaders();
      await http.post(Uri.parse(ApiConfig.cancelTrip),
          headers: {...h, 'Content-Type': 'application/json'},
          body: jsonEncode({
            'tripId': tripId,
            'reason': 'Auto-cancelled: no pilot available nearby'
          }));
    } catch (_) {}
    if (!mounted) return;
    setState(() => _activeTrip = null);
    ScaffoldMessenger.of(context).showSnackBar(SnackBar(
      content: Text('No pilot found nearby. Ride auto-cancelled.',
          style: GoogleFonts.poppins(
              color: Colors.white, fontWeight: FontWeight.w400, fontSize: 13)),
      backgroundColor: JT.primaryDark,
      behavior: SnackBarBehavior.floating,
      margin: const EdgeInsets.fromLTRB(16, 0, 16, 16),
      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12)),
      duration: const Duration(seconds: 5),
    ));
  }

  Future<void> _maybeShowTutorial() async {
    final prefs = await SharedPreferences.getInstance();
    final seen = prefs.getBool('home_tutorial_seen') ?? false;
    if (seen || !mounted) return;
    await prefs.setBool('home_tutorial_seen', true);
    // Small delay so the home screen finishes building first
    await Future.delayed(const Duration(milliseconds: 800));
    if (!mounted) return;
    showDialog(
      context: context,
      barrierDismissible: true,
      barrierColor: Colors.black.withValues(alpha: 0.75),
      builder: (ctx) => Dialog(
        backgroundColor: Colors.transparent,
        insetPadding: const EdgeInsets.all(20),
        child: Container(
          decoration: BoxDecoration(
            color: Colors.white,
            borderRadius: BorderRadius.circular(24),
          ),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              Container(
                padding: const EdgeInsets.all(20),
                decoration: const BoxDecoration(
                  color: JT.primary,
                  borderRadius: BorderRadius.vertical(top: Radius.circular(24)),
                ),
                child: Row(
                  children: [
                    const Text('👋', style: TextStyle(fontSize: 28)),
                    const SizedBox(width: 12),
                    Expanded(
                      child: Column(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            Text('Welcome!',
                                style: GoogleFonts.poppins(
                                    color: Colors.white,
                                    fontWeight: FontWeight.w400,
                                    fontSize: 18)),
                            Text('Here\'s a quick guide to get you started',
                                style: GoogleFonts.poppins(
                                    color: Colors.white.withValues(alpha: 0.85),
                                    fontSize: 12)),
                          ]),
                    ),
                  ],
                ),
              ),
              Padding(
                padding: const EdgeInsets.all(20),
                child: Column(
                  children: [
                    _TutorialTip(
                        icon: '🔍',
                        title: 'Search Destination',
                        desc:
                            'Tap "Where do you want to go?" to search for your destination and see instant fare estimates.'),
                    const SizedBox(height: 14),
                    _TutorialTip(
                        icon: '🚗',
                        title: 'Choose a Service',
                        desc:
                            'Select from Auto, Bike, Car, Ride Pool, Parcel, and more based on your need.'),
                    const SizedBox(height: 14),
                    _TutorialTip(
                        icon: '💳',
                        title: 'Wallet & Payments',
                        desc:
                            'Recharge your wallet for cashless rides. Tap the wallet icon in the top right.'),
                    const SizedBox(height: 14),
                    _TutorialTip(
                        icon: '🔔',
                        title: 'Stay Updated',
                        desc:
                            'Enable notifications to get real-time alerts for your rides, offers, and more.'),
                    const SizedBox(height: 20),
                    SizedBox(
                      width: double.infinity,
                      child: JT.gradientButton(
                          label: "Got it, Let's Go!",
                          onTap: () => Navigator.pop(ctx)),
                    ),
                  ],
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }

  void _connectSocket() {
    _socket.connect(ApiConfig.socketUrl).then((_) {
      // IMPORTANT: Reduced delay to 500ms to ensure faster responsiveness
      // while still avoiding immediate stale navigation on initial connection.
      Future.delayed(const Duration(milliseconds: 500), () {
        if (!mounted) return;
        _driverAssignedSub = _socket.onDriverAssigned.listen((data) {
          if (!mounted) return;
          final tripId = data['tripId']?.toString() ?? '';
          // Only navigate if the tripId matches our current active trip context
          // This prevents stale socket events from navigating incorrectly
          if (tripId.isNotEmpty) {
            final activeTripId = _activeTrip?['id']?.toString() ?? '';
            // Only navigate if we have a confirmed active trip matching this event.
            // Prevents stale socket events from causing blank-screen navigation on login.
            // Only navigate if this is the active screen (prevents double-navigation
            // if BookingScreen is already on top or TrackingScreen is already open)
            final isCurrent = ModalRoute.of(context)?.isCurrent ?? false;
            if (activeTripId.isNotEmpty && activeTripId == tripId && isCurrent) {
              Navigator.pushReplacement(
                  context,
                  MaterialPageRoute(
                      builder: (_) => TrackingScreen(tripId: tripId)));
            }
          }
        });

        // Clear active trip state when trip is cancelled or completed
        _tripCancelledSub = _socket.onTripCancelled.listen((data) {
          if (!mounted) return;
          _searchingTimer?.cancel();
          _statePollTimer?.cancel();
          setState(() => _activeTrip = null);
        });
        _tripStatusSub = _socket.onTripStatus.listen((data) {
          if (!mounted) return;
          final status = data['status']?.toString() ?? '';
          if (status == 'completed' || status == 'cancelled') {
            _searchingTimer?.cancel();
            _statePollTimer?.cancel();
            setState(() => _activeTrip = null);
          }
        });
      });
    });
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    _loadingTimeout?.cancel();
    _bannerTimer?.cancel();
    _searchingTimer?.cancel();
    _statePollTimer?.cancel();
    _bannerPageCtrl.dispose();
    _driverAssignedSub?.cancel();
    _tripCancelledSub?.cancel();
    _tripStatusSub?.cancel();
    _nearbyDriversTimer?.cancel();
    _mapController?.dispose();
    // Don't disconnect socket — it's a shared singleton used by other screens
    super.dispose();
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state == AppLifecycleState.paused ||
        state == AppLifecycleState.inactive) {
      // App went to background — pause the nearby-drivers poll to save battery
      _nearbyDriversTimer?.cancel();
      _nearbyDriversTimer = null;
    } else if (state == AppLifecycleState.resumed) {
      // App came back to foreground — refresh pickup location and restart polling
      _getLocation();
      if (_nearbyDriversTimer == null) {
        _nearbyDriversTimer = Timer.periodic(
            const Duration(seconds: 10), (_) => _fetchNearbyDrivers());
        _fetchNearbyDrivers(); // refresh immediately on resume
      }
    }
  }

  Future<void> _loadUser() async {
    final prefs = await SharedPreferences.getInstance();
    if (!mounted) return;
    setState(() {
      _userName = prefs.getString('user_name') ?? 'there';
      _userPhone = prefs.getString('user_phone') ?? '';
    });
  }

  Future<void> _showLocationPrompt({
    required String title,
    required String message,
    required Future<bool> Function() openSettings,
  }) async {
    if (!mounted) return;
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

  Future<void> _getLocation() async {
    try {
      final fallbackPosition = await Geolocator.getLastKnownPosition();
      final serviceEnabled = await Geolocator.isLocationServiceEnabled();
      if (!serviceEnabled) {
        if (fallbackPosition != null && mounted) {
          setState(() {
            _pickupLat = fallbackPosition.latitude;
            _pickupLng = fallbackPosition.longitude;
            _locationReady = true;
            _pickup = 'Using last known location';
          });
          _reverseGeocode(
              fallbackPosition.latitude, fallbackPosition.longitude);
          _mapController?.animateCamera(
            CameraUpdate.newLatLngZoom(
              LatLng(fallbackPosition.latitude, fallbackPosition.longitude),
              15,
            ),
          );
          _fetchNearbyDrivers();
        } else if (mounted) {
          setState(() {
            _pickup = 'Turn on location services to detect pickup';
            _locationReady = false;
          });
          await _showLocationPrompt(
            title: 'Location Services Off',
            message:
                'Turn on device location so we can detect your live pickup point accurately.',
            openSettings: Geolocator.openLocationSettings,
          );
        }
        return;
      }

      LocationPermission perm = await Geolocator.checkPermission();
      if (perm == LocationPermission.denied) {
        perm = await Geolocator.requestPermission();
      }
      if (perm == LocationPermission.denied) {
        if (mounted) {
          setState(() {
            _pickup = 'Location permission is needed to detect pickup';
            _locationReady = false;
          });
        }
        return;
      }
      if (perm == LocationPermission.deniedForever) {
        if (!mounted) return;
        setState(() {
          _pickup = 'Location permission is blocked. Open settings to enable it.';
          _locationReady = false;
        });
        showDialog(
          context: context,
          barrierDismissible: false,
          builder: (_) => AlertDialog(
            title: const Text('Location Required'),
            content: const Text(
                'Location access is required to request rides. Please enable it in your device settings.'),
            actions: [
              TextButton(
                  onPressed: () => Navigator.pop(context),
                  child: const Text('Cancel')),
              ElevatedButton(
                onPressed: () {
                  Navigator.pop(context);
                  Geolocator.openAppSettings();
                },
                child: const Text('Open Settings'),
              ),
            ],
          ),
        );
        return;
      }

      Position? pos;
      try {
        pos = await Geolocator.getCurrentPosition(
          locationSettings: const LocationSettings(
            accuracy: LocationAccuracy.high,
            timeLimit: Duration(seconds: 10),
          ),
        );
      } catch (_) {
        pos = fallbackPosition;
      }

      if (pos == null) {
        if (mounted) {
          setState(() {
            _pickup = 'Could not detect your location. Tap to retry.';
            _locationReady = false;
          });
        }
        return;
      }

      if (mounted) {
        setState(() {
          _pickupLat = pos!.latitude;
          _pickupLng = pos.longitude;
          _locationReady = true;
          _pickup = 'Current Location'; // placeholder — overwritten by _reverseGeocode
        });
      }
      _reverseGeocode(pos.latitude, pos.longitude);
      _mapController?.animateCamera(
        CameraUpdate.newLatLngZoom(LatLng(pos.latitude, pos.longitude), 16),
      );
      _fetchNearbyDrivers();
    } catch (_) {
      // Unexpected error — try last known position before giving up
      try {
        final last = await Geolocator.getLastKnownPosition();
        if (last != null && mounted) {
          setState(() {
            _pickupLat = last.latitude;
            _pickupLng = last.longitude;
            _locationReady = true;
            _pickup = 'Current Location';
          });
          _reverseGeocode(last.latitude, last.longitude);
          _mapController?.animateCamera(
            CameraUpdate.newLatLngZoom(LatLng(last.latitude, last.longitude), 15),
          );
          _fetchNearbyDrivers();
          return;
        }
      } catch (_) {}
      if (mounted) {
        setState(() {
          _pickup = 'Tap to detect your location';
          _locationReady = false;
        });
      }
    }
  }

  Future<void> _reverseGeocode(double lat, double lng) async {
    // Try server proxy first
    try {
      final headers = await AuthService.getHeaders();
      final res = await http.get(
        Uri.parse('${ApiConfig.reverseGeocode}?lat=$lat&lng=$lng'),
        headers: headers,
      ).timeout(const Duration(seconds: 6));
      if (res.statusCode == 200) {
        final data = jsonDecode(res.body) as Map<String, dynamic>;
        final addr = data['formattedAddress']?.toString() ?? '';
        if (mounted && addr.isNotEmpty) {
          setState(() => _pickup = addr);
          return;
        }
      }
    } catch (_) {}
    // Nominatim fallback — no key required
    try {
      final res = await http.get(
        Uri.parse(
            'https://nominatim.openstreetmap.org/reverse?format=json&lat=$lat&lon=$lng'),
        headers: const {'User-Agent': 'JagoPro/1.0'},
      ).timeout(const Duration(seconds: 5));
      if (res.statusCode == 200) {
        final data = jsonDecode(res.body) as Map<String, dynamic>;
        final addr = data['display_name']?.toString() ?? '';
        if (mounted && addr.isNotEmpty) {
          // Trim to first 3 components for readability
          final short = addr.split(',').take(3).join(',').trim();
          setState(() => _pickup = short.isNotEmpty ? short : 'Current Location');
          return;
        }
      }
    } catch (_) {}
    // Final fallback — keep 'Current Location' set by caller
    if (mounted && (_pickup.isEmpty)) {
      setState(() => _pickup = 'Current Location');
    }
  }

  void _handleUnauthorized() {
    AuthService.logout().then((_) {
      if (!mounted) return;
      Navigator.pushAndRemoveUntil(context,
          MaterialPageRoute(builder: (_) => const LoginScreen()), (_) => false);
    });
  }

  Future<void> _fetchHome() async {
    try {
      final headers = await AuthService.getHeaders();
      final r = await http
          .get(Uri.parse(ApiConfig.customerHomeData), headers: headers)
          .timeout(const Duration(seconds: 6));
      if (r.statusCode == 401) {
        if (mounted) setState(() => _homeLoading = false);
        _handleUnauthorized();
        return;
      }
      if (r.statusCode == 200 && mounted) {
        final data = jsonDecode(r.body) as Map<String, dynamic>;
        final cats = (data['vehicleCategories'] as List<dynamic>?)
                ?.cast<Map<String, dynamic>>() ??
            [];
        setState(() => _vehicleCategories = cats);
      }
    } catch (_) {}
    if (mounted) setState(() => _homeLoading = false);
  }

  Map<String, dynamic> _vehicleStyle(String name) {
    final n = name.toLowerCase();
    if (n.contains('bike parcel') || n.contains('parcel bike'))
      return {
        'icon': Icons.inventory_2_rounded,
        'color': const Color(0xFF1A6FDB),
        'gradient': [const Color(0xFF1A6FDB), const Color(0xFF1A6FDB)],
      };
    if (n.contains('bike'))
      return {
        'icon': Icons.electric_bike_rounded,
        'color': JT.primary,
        'gradient': [JT.primary, JT.primary],
      };
    if (n.contains('auto'))
      return {
        'icon': Icons.electric_rickshaw_rounded,
        'color': const Color(0xFF5B9DFF),
        'gradient': [const Color(0xFF5B9DFF), const Color(0xFF5B9DFF)],
      };
    if (n.contains('truck') ||
        n.contains('cargo') ||
        n.contains('tata') ||
        n.contains('pickup'))
      return {
        'icon': Icons.local_shipping_rounded,
        'color': const Color(0xFF2563EB),
        'gradient': [const Color(0xFF2563EB), const Color(0xFF2563EB)],
      };
    if (n.contains('parcel') || n.contains('delivery'))
      return {
        'icon': Icons.inventory_2_rounded,
        'color': const Color(0xFF1A6FDB),
        'gradient': [const Color(0xFF1A6FDB), const Color(0xFF1A6FDB)],
      };
    if (n.contains('suv') || n.contains('car') || n.contains('cab'))
      return {
        'icon': Icons.directions_car_filled_rounded,
        'color': const Color(0xFF2563EB),
        'gradient': [const Color(0xFF2563EB), const Color(0xFF2563EB)],
      };
    if (n.contains('pool') ||
        n.contains('share') ||
        n.contains('all') ||
        n.contains('service'))
      return {
        'icon': Icons.grid_view_rounded,
        'color': JT.primary,
        'gradient': [JT.primary, JT.primary],
      };
    return {
      'icon': Icons.directions_car_filled_rounded,
      'color': JT.primary,
      'gradient': [JT.primary, JT.primary],
    };
  }

  void _openSearch({String? presetVehicle}) {
    // Rule: ALL ride entry points go Home → LocationScreen → BookingScreen
    Navigator.push(
        context,
        MaterialPageRoute(
          builder: (_) => PremiumLocationScreen(
            serviceType: 'ride',
            pickupAddress: _pickup.isNotEmpty ? _pickup : null,
            pickupLat: _pickupLat,
            pickupLng: _pickupLng,
          ),
        ));
  }

  @override
  Widget build(BuildContext context) {
    const isDark = false;
    final screenWidth = MediaQuery.of(context).size.width;
    final gridRatio = screenWidth < 380 ? 2.1 : (screenWidth > 600 ? 3.0 : 2.3);
    final textScale = screenWidth < 380 ? 0.9 : 1.0;

    return Scaffold(
      key: _scaffoldKey,
      backgroundColor: Colors.white, // White base — no colored strip at bottom ever
      drawer: _buildDrawer(isDark),
      body: SingleChildScrollView(
              physics: const BouncingScrollPhysics(),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  const SizedBox(height: 24),
                        // Greeting
                        Padding(
                  padding: const EdgeInsets.fromLTRB(20, 4, 20, 8), // Reduced top margin from 12 to 4
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(
                        "Hello ${_userName == 'there' ? 'Muhammad' : _userName.split(' ').first},", // Using Muhammad as default fallback matching image
                        style: GoogleFonts.poppins(
                          fontSize: 22,
                          fontWeight: FontWeight.w500,
                          color: const Color(0xFF1E293B),
                        ),
                      ),
                      Text(
                        "Where to go?",
                        style: GoogleFonts.poppins(
                          fontSize: 22,
                          fontWeight: FontWeight.w600,
                          color: const Color(0xFF3B48D1), // Deep blue
                        ),
                      ),
                    ],
                  ),
                ),
                
                const SizedBox(height: 12),
                
                // Destination Block
                Padding(
                  padding: const EdgeInsets.symmetric(horizontal: 20),
                  child: Container(
                    decoration: BoxDecoration(
                      color: Colors.white,
                      borderRadius: BorderRadius.circular(20),
                      boxShadow: [
                        BoxShadow(color: Colors.black.withValues(alpha: 0.04), blurRadius: 10, offset: const Offset(0, 4)),
                      ],
                    ),
                    child: Stack(
                      alignment: Alignment.centerRight,
                      children: [
                        Column(
                          mainAxisSize: MainAxisSize.min,
                          children: [
                            // From
                            GestureDetector(
                              onTap: () => Navigator.push(context, MaterialPageRoute(builder: (_) => PremiumLocationScreen(serviceType: 'ride', pickupAddress: _pickup.isNotEmpty ? _pickup : null, pickupLat: _pickupLat, pickupLng: _pickupLng))),
                              child: Padding(
                                padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 14),
                                child: Row(
                                  children: [
                                    const Icon(Icons.location_on, color: Color(0xFF10B981), size: 20),
                                    const SizedBox(width: 12),
                                    Expanded(
                                      child: Column(
                                        crossAxisAlignment: CrossAxisAlignment.start,
                                        children: [
                                          const Text("From", style: TextStyle(fontSize: 12, color: Color(0xFF94A3B8))),
                                          const SizedBox(height: 2),
                                          Text(
                                            _pickup.isNotEmpty ? (_pickup.contains(',') ? _pickup.split(',').first : _pickup) : "Current Location",
                                            maxLines: 1, 
                                            overflow: TextOverflow.ellipsis, 
                                            style: GoogleFonts.poppins(fontSize: 15, fontWeight: FontWeight.w600, color: const Color(0xFF1E293B)),
                                          ),
                                        ],
                                      ),
                                    ),
                                    const SizedBox(width: 40), // Spacing for the right button
                                  ],
                                ),
                              ),
                            ),
                            Divider(height: 1, thickness: 1, color: const Color(0xFFE2E8F0), indent: 48, endIndent: 16),
                            // To
                            GestureDetector(
                              onTap: () => Navigator.push(context, MaterialPageRoute(builder: (_) => PremiumLocationScreen(serviceType: 'ride', pickupAddress: _pickup.isNotEmpty ? _pickup : null, pickupLat: _pickupLat, pickupLng: _pickupLng))),
                              child: Padding(
                                padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 14),
                                child: Row(
                                  children: [
                                    const Icon(Icons.location_on, color: Color(0xFFEF4444), size: 20),
                                    const SizedBox(width: 12),
                                    Expanded(
                                      child: Column(
                                        crossAxisAlignment: CrossAxisAlignment.start,
                                        children: [
                                          const Text("To", style: TextStyle(fontSize: 12, color: Color(0xFF94A3B8))),
                                          const SizedBox(height: 2),
                                          Text(
                                            "Where are you going?", 
                                            maxLines: 1, 
                                            overflow: TextOverflow.ellipsis, 
                                            style: GoogleFonts.poppins(fontSize: 15, fontWeight: FontWeight.w600, color: const Color(0xFF1E293B)),
                                          ),
                                        ],
                                      ),
                                    ),
                                    const SizedBox(width: 40),
                                  ],
                                ),
                              ),
                            ),
                          ],
                        ),
                        // Swap / Action button on right
                        Positioned(
                          right: 16,
                          child: GestureDetector(
                            onTap: () => Navigator.push(context, MaterialPageRoute(builder: (_) => PremiumLocationScreen(serviceType: 'ride', pickupAddress: _pickup.isNotEmpty ? _pickup : null, pickupLat: _pickupLat, pickupLng: _pickupLng))),
                            child: Container(
                              width: 36,
                              height: 36,
                              decoration: BoxDecoration(
                                color: const Color(0xFFF1F5F9),
                                shape: BoxShape.circle,
                              ),
                              child: const Icon(Icons.swap_vert_rounded, color: Color(0xFF3B48D1), size: 20),
                            ),
                          ),
                        ),
                      ],
                    ),
                  ),
                ),
                
                const SizedBox(height: 16),
                
                // Action Buttons (Modern Rectangle Cards)
                Padding(
                  padding: const EdgeInsets.symmetric(horizontal: 20),
                  child: Row(
                    children: [
                      // Book a Ride
                      Expanded(
                        child: GestureDetector(
                          onTap: () => Navigator.push(context, MaterialPageRoute(builder: (_) => PremiumLocationScreen(serviceType: 'ride', pickupAddress: _pickup.isNotEmpty ? _pickup : null, pickupLat: _pickupLat, pickupLng: _pickupLng))),
                          child: Container(
                            height: 120, // Reduced height for more compact look
                            decoration: BoxDecoration(
                              gradient: const LinearGradient(colors: [Color(0xFF4F4ACF), Color(0xFF6366F1)], begin: Alignment.topLeft, end: Alignment.bottomRight),
                              borderRadius: BorderRadius.circular(16), 
                              boxShadow: [
                                BoxShadow(color: const Color(0xFF4F4ACF).withValues(alpha: 0.3), blurRadius: 12, offset: const Offset(0, 4)),
                              ],
                            ),
                            child: Stack(
                              children: [
                                // Text at the top
                                Positioned(
                                  top: 14, left: 16,
                                  child: SizedBox(
                                    width: (screenWidth / 2) - 60,
                                    child: FittedBox(
                                      alignment: Alignment.centerLeft,
                                      fit: BoxFit.scaleDown,
                                      child: Text("Book a Ride", style: TextStyle(color: Colors.white, fontSize: 16 * textScale, fontWeight: FontWeight.w900)),
                                    ),
                                  ),
                                ),
                                // New brand image on the left
                                Positioned(
                                  bottom: -8, left: -8,
                                  child: Image.network(
                                    'https://res.cloudinary.com/kits/image/upload/q_auto/f_auto/v1775370325/04bcf87d-433e-4508-b475-78eaee34ff98_qxbn2c.png',
                                    height: 85,
                                    fit: BoxFit.contain,
                                  ),
                                ),
                                // Large 3D Car Image centered at the bottom
                                Positioned(
                                  bottom: 10, right: 10,
                                  child: Image.network(
                                    'https://res.cloudinary.com/kits/image/upload/q_auto/f_auto/v1775129355/ChatGPT_Image_Apr_2_2026_04_59_00_PM_rlsvjz.png',
                                    height: 80, // Slightly smaller for 120 height
                                    fit: BoxFit.contain,
                                  ),
                                ),
                              ],
                            ),
                          ),
                        ),
                      ),
                      const SizedBox(width: 14),
                      // Send Parcel
                      Expanded(
                        child: GestureDetector(
                          onTap: () => Navigator.push(context, MaterialPageRoute(builder: (_) => ParcelBookingScreen(pickupAddress: _pickup, pickupLat: _pickupLat, pickupLng: _pickupLng))),
                          child: Container(
                            height: 120, // Matching reduced height
                            decoration: BoxDecoration(
                              gradient: const LinearGradient(colors: [Color(0xFFC29763), Color(0xFFD6B58F)], begin: Alignment.topLeft, end: Alignment.bottomRight),
                              borderRadius: BorderRadius.circular(16), 
                              boxShadow: [
                                BoxShadow(color: const Color(0xFFC29763).withValues(alpha: 0.3), blurRadius: 12, offset: const Offset(0, 4)),
                              ],
                            ),
                            child: Stack(
                              children: [
                                // Text at the top
                                Positioned(
                                  top: 14, left: 16,
                                  child: SizedBox(
                                    width: (screenWidth / 2) - 60,
                                    child: FittedBox(
                                      alignment: Alignment.centerLeft,
                                      fit: BoxFit.scaleDown,
                                      child: Text("Send Parcel", style: TextStyle(color: Colors.white, fontSize: 16 * textScale, fontWeight: FontWeight.w900)),
                                    ),
                                  ),
                                ),
                                // Delivery image on the left side
                                Positioned(
                                  bottom: -8, left: -8,
                                  child: Image.network(
                                    'https://res.cloudinary.com/kits/image/upload/q_auto/f_auto/v1775367404/be5b86c2-7a8a-4dbd-ad33-e8da2b627d5e_vurdrg.png',
                                    height: 85,
                                    fit: BoxFit.contain,
                                  ),
                                ),
                                // Large 3D Gift/Box Image centered at the bottom
                                Positioned(
                                  bottom: 10, right: 10,
                                  child: Image.network(
                                    'https://res.cloudinary.com/kits/image/upload/q_auto/f_auto/v1775128882/ChatGPT_Image_Apr_2_2026_04_47_08_PM_zg8llx.png',
                                    height: 75, // Slightly smaller for 120 height
                                    fit: BoxFit.contain,
                                  ),
                                ),
                              ],
                            ),
                          ),
                        ),
                      ),
                    ],
                  ),
                ),
                
                const SizedBox(height: 16),
                
                // Our Services Header
                Padding(
                  padding: const EdgeInsets.symmetric(horizontal: 20),
                  child: const Text("Our Services", style: TextStyle(fontSize: 22, fontWeight: FontWeight.w900, color: Color(0xFF1E293B), letterSpacing: -0.5)),
                ),
                
                const SizedBox(height: 12),
                
                // Our Services Grid
                GridView.count(
                  shrinkWrap: true,
                  physics: const NeverScrollableScrollPhysics(),
                  padding: const EdgeInsets.symmetric(horizontal: 20, vertical: 4),
                  crossAxisCount: 2,
                  childAspectRatio: gridRatio, // Responsive ratio based on screen width
                  crossAxisSpacing: 12,
                  mainAxisSpacing: 12,
                  children: [
                      // Bike (Hero 3D Model style)
                      GestureDetector(
                        onTap: () => Navigator.push(context, MaterialPageRoute(builder: (_) => PremiumLocationScreen(serviceType: 'ride', vehicleCategoryName: 'Bike', pickupAddress: _pickup.isNotEmpty ? _pickup : null, pickupLat: _pickupLat, pickupLng: _pickupLng))),
                        child: Container(
                          decoration: BoxDecoration(
                            color: Colors.white, 
                            borderRadius: BorderRadius.circular(16),
                            boxShadow: [
                              BoxShadow(color: Colors.black.withValues(alpha: 0.05), blurRadius: 10, offset: const Offset(0, 4)),
                            ],
                          ),
                          child: Stack(
                            clipBehavior: Clip.none, // Allow 3D image overflow
                            children: [
                              // Label on the left
                              Positioned(
                                left: 16,
                                top: 0,
                                bottom: 0,
                                  child: FittedBox(
                                    fit: BoxFit.scaleDown,
                                    child: Text("Bike", style: TextStyle(color: Color(0xFF1E293B), fontSize: 18 * textScale, fontWeight: FontWeight.bold)),
                                  ),
                              ),
                              // Large 3D Bike Image on the right
                              Positioned(
                                right: -12, 
                                top: -12,
                                bottom: -12,
                                child: Image.network(
                                  'https://res.cloudinary.com/kits/image/upload/q_auto/f_auto/v1775123974/bike_logo_g7idrq.png',
                                  width: 105, // Much larger for visibility
                                  fit: BoxFit.contain,
                                ),
                              ),
                            ],
                          ),
                        ),
                      ),
                      // Auto (Hero 3D Model style)
                      GestureDetector(
                        onTap: () => Navigator.push(context, MaterialPageRoute(builder: (_) => PremiumLocationScreen(serviceType: 'ride', vehicleCategoryName: 'Auto', pickupAddress: _pickup.isNotEmpty ? _pickup : null, pickupLat: _pickupLat, pickupLng: _pickupLng))),
                        child: Container(
                          decoration: BoxDecoration(
                            color: Colors.white, 
                            borderRadius: BorderRadius.circular(16),
                            boxShadow: [
                              BoxShadow(color: Colors.black.withValues(alpha: 0.05), blurRadius: 10, offset: const Offset(0, 4)),
                            ],
                          ),
                          child: Stack(
                            clipBehavior: Clip.none, 
                            children: [
                              // Label on the left
                              Positioned(
                                left: 16,
                                top: 0,
                                bottom: 0,
                                  child: FittedBox(
                                    fit: BoxFit.scaleDown,
                                    child: Text("Auto", style: TextStyle(color: Color(0xFF1E293B), fontSize: 18 * textScale, fontWeight: FontWeight.bold)),
                                  ),
                              ),
                              // Large 3D Auto (Rickshaw) Image on the right
                              Positioned(
                                right: -12, 
                                top: -12,
                                bottom: -12,
                                child: Image.network(
                                  'https://res.cloudinary.com/kits/image/upload/q_auto/f_auto/v1775125550/ChatGPT_Image_Apr_2_2026_03_55_30_PM_ywb7fj.png',
                                  width: 105, 
                                  fit: BoxFit.contain,
                                ),
                              ),
                            ],
                          ),
                        ),
                      ),
                      // Cab (Hero 3D Model style)
                      GestureDetector(
                        onTap: () => Navigator.push(context, MaterialPageRoute(builder: (_) => PremiumLocationScreen(serviceType: 'ride', vehicleCategoryName: 'Cab', pickupAddress: _pickup.isNotEmpty ? _pickup : null, pickupLat: _pickupLat, pickupLng: _pickupLng))),
                        child: Container(
                          decoration: BoxDecoration(
                            color: Colors.white, 
                            borderRadius: BorderRadius.circular(16),
                            boxShadow: [
                              BoxShadow(color: Colors.black.withValues(alpha: 0.05), blurRadius: 10, offset: const Offset(0, 4)),
                            ],
                          ),
                          child: Stack(
                            clipBehavior: Clip.none, 
                            children: [
                              // Label on the left
                              Positioned(
                                left: 16,
                                top: 0,
                                bottom: 0,
                                  child: FittedBox(
                                    fit: BoxFit.scaleDown,
                                    child: Text("Cab", style: TextStyle(color: Color(0xFF1E293B), fontSize: 18 * textScale, fontWeight: FontWeight.bold)),
                                  ),
                              ),
                              // Large 3D Cab Image on the right
                              Positioned(
                                right: -12, 
                                top: -12,
                                bottom: -12,
                                child: Image.network(
                                  'https://res.cloudinary.com/dg5ct7fys/image/upload/f_auto,q_auto/ChatGPT_Image_Apr_17_2026_11_27_28_AM_w0rcnh',
                                  width: 105, 
                                  fit: BoxFit.contain,
                                ),
                              ),
                            ],
                          ),
                        ),
                      ),
                      // Premium (Hero 3D Model style)
                      GestureDetector(
                        onTap: () => Navigator.push(context, MaterialPageRoute(builder: (_) => PremiumLocationScreen(serviceType: 'ride', vehicleCategoryName: 'Premium', pickupAddress: _pickup.isNotEmpty ? _pickup : null, pickupLat: _pickupLat, pickupLng: _pickupLng))),
                        child: Container(
                          decoration: BoxDecoration(
                            color: Colors.white, 
                            borderRadius: BorderRadius.circular(16),
                            boxShadow: [
                              BoxShadow(color: Colors.black.withValues(alpha: 0.05), blurRadius: 10, offset: const Offset(0, 4)),
                            ],
                          ),
                          child: Stack(
                            clipBehavior: Clip.none, 
                            children: [
                              // Label on the left
                              Positioned(
                                left: 12, // Adjusted padding
                                top: 0,
                                bottom: 0,
                                  child: FittedBox(
                                    fit: BoxFit.scaleDown,
                                    child: Text("Premium", style: TextStyle(color: Color(0xFF1E293B), fontSize: 15 * textScale, fontWeight: FontWeight.bold)),
                                  ),
                              ),
                              // Large 3D Premium Image on the right
                              Positioned(
                                right: -15, 
                                top: -12,
                                bottom: -12,
                                child: Image.network(
                                  'https://res.cloudinary.com/dg5ct7fys/image/upload/f_auto,q_auto/ChatGPT_Image_Apr_17_2026_11_31_05_AM_kavp5e',
                                  width: 100, 
                                  fit: BoxFit.contain,
                                ),
                              ),
                            ],
                          ),
                        ),
                      ),
                      // Parcel (Hero 3D Model style)
                      GestureDetector(
                        onTap: () => Navigator.push(context, MaterialPageRoute(builder: (_) => ParcelBookingScreen(pickupAddress: _pickup, pickupLat: _pickupLat, pickupLng: _pickupLng))),
                        child: Container(
                          decoration: BoxDecoration(
                            color: Colors.white, 
                            borderRadius: BorderRadius.circular(16),
                            boxShadow: [
                              BoxShadow(color: Colors.black.withValues(alpha: 0.05), blurRadius: 10, offset: const Offset(0, 4)),
                            ],
                          ),
                          child: Stack(
                            clipBehavior: Clip.none, 
                            children: [
                              // Label on the left
                              Positioned(
                                left: 16,
                                top: 0,
                                bottom: 0,
                                  child: FittedBox(
                                    fit: BoxFit.scaleDown,
                                    child: Text("Parcel", style: TextStyle(color: Color(0xFF1E293B), fontSize: 18 * textScale, fontWeight: FontWeight.bold)),
                                  ),
                              ),
                              // Large 3D Parcel Image on the right
                              Positioned(
                                right: -12, 
                                top: -12,
                                bottom: -12,
                                child: Image.network(
                                  'https://res.cloudinary.com/kits/image/upload/q_auto/f_auto/v1775126915/ChatGPT_Image_Apr_2_2026_04_18_17_PM_g83nv8.png',
                                  width: 105, 
                                  fit: BoxFit.contain,
                                ),
                              ),
                            ],
                          ),
                        ),
                      ),
                        // Delivery (Hero 3D Model style)
                        GestureDetector(
                          onTap: () => Navigator.push(context, MaterialPageRoute(builder: (_) => ParcelBookingScreen(pickupAddress: _pickup, pickupLat: _pickupLat, pickupLng: _pickupLng))),
                          child: Container(
                            decoration: BoxDecoration(
                              color: Colors.white, 
                              borderRadius: BorderRadius.circular(16),
                              boxShadow: [
                                BoxShadow(color: Colors.black.withValues(alpha: 0.05), blurRadius: 10, offset: const Offset(0, 4)),
                              ],
                            ),
                            child: Stack(
                              clipBehavior: Clip.none, 
                              children: [
                                // Label on the left
                                Positioned(
                                  left: 12, top: 0, bottom: 0,
                                  child: Center(
                                    child: SizedBox(
                                      width: (screenWidth / 2) - 50,
                                      child: FittedBox(
                                        alignment: Alignment.centerLeft,
                                        fit: BoxFit.scaleDown,
                                        child: Text("Delivery", style: TextStyle(color: Color(0xFF1E293B), fontSize: 15 * textScale, fontWeight: FontWeight.bold)),
                                      ),
                                    ),
                                  ),
                                ),
                                // Large 3D Delivery Image on the right
                                Positioned(
                                  right: -15, 
                                  top: -12,
                                  bottom: -12,
                                  child: Image.network(
                                    'https://res.cloudinary.com/kits/image/upload/q_auto/f_auto/v1775367404/be5b86c2-7a8a-4dbd-ad33-e8da2b627d5e_vurdrg.png',
                                    width: 115, 
                                    fit: BoxFit.contain,
                                  ),
                                ),
                              ],
                            ),
                          ),
                        ),
                      ],
                    ),
                  // Removed Extra ) for Expanded

                  // Active trip banner
                  if (_activeTrip != null) ...[
                    const SizedBox(height: 12),
                    Padding(
                      padding: const EdgeInsets.symmetric(horizontal: 20),
                      child: _buildActiveTripBanner(false),
                    ),
                  ],

                  // Add padding at the bottom of the scroll view
                  const SizedBox(height: 20),
                ],
              ),
            ),
    );
  }

  // Approximate height of the visible bottom card area — responsive
  // ── FEATURED SERVICES — RIDE + PARCEL (admin-controlled) ────────────────
  // Only shows cards for services that have active vehicle categories in DB.
  Widget buildFeaturedGrid(bool isDark) {
    if (_vehicleCategories.isEmpty) {
      return Padding(
        padding: const EdgeInsets.fromLTRB(16, 20, 16, 0),
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Text('Our Services',
              style: GoogleFonts.poppins(
                  fontSize: 16,
                  fontWeight: FontWeight.w400,
                  color: JT.textPrimary)),
          const SizedBox(height: 14),
          Container(
            padding: const EdgeInsets.all(24),
            decoration: BoxDecoration(
              color: Colors.white,
              borderRadius: BorderRadius.circular(20),
              border: Border.all(color: JT.border),
              boxShadow: JT.cardShadow,
            ),
            child: Column(mainAxisSize: MainAxisSize.min, children: [
              Container(
                width: 72,
                height: 72,
                decoration: BoxDecoration(
                  color: JT.primary.withValues(alpha: 0.08),
                  borderRadius: BorderRadius.circular(22),
                ),
                child: const Icon(Icons.wifi_tethering_error_rounded,
                    color: JT.primary, size: 34),
              ),
              const SizedBox(height: 14),
              Text('Services Unavailable',
                  textAlign: TextAlign.center,
                  style: GoogleFonts.poppins(
                      fontSize: 16,
                      fontWeight: FontWeight.w500,
                      color: JT.textPrimary)),
              const SizedBox(height: 6),
              Text('We are currently setting up in your area',
                  textAlign: TextAlign.center,
                  style: GoogleFonts.poppins(
                      fontSize: 12, color: JT.textSecondary, height: 1.4)),
            ]),
          ),
        ]),
      );
    }

    final rideCats = _vehicleCategories.where((v) => v['type']?.toString() == 'ride').toList();
    final parcelCats = _vehicleCategories.where((v) => v['type']?.toString() == 'parcel' || v['type']?.toString() == 'cargo').toList();
    
    final isRideActive = rideCats.any((v) => v['isActive'] == true);
    final isParcelActive = parcelCats.any((v) => v['isActive'] == true);

    return Padding(
      padding: const EdgeInsets.fromLTRB(16, 20, 16, 0),
      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Text('Our Services',
            style: GoogleFonts.poppins(
                fontSize: 16,
                fontWeight: FontWeight.w400,
                color: JT.textPrimary)),
        const SizedBox(height: 14),
        Row(children: [
          // ── Ride card — reflect admin toggle ──
          if (rideCats.isNotEmpty)
            Expanded(
                child: _buildServiceCard(
              imageUrl: 'https://oyster-app-9e9cd.ondigitalocean.app/static/vehicles/auto.png',
              fallbackIcon: Icons.electric_rickshaw_rounded,
              title: 'Ride',
              subtitle: 'Bike · Auto · Car',
              accent: const Color(0xFF2563EB),
              isActive: isRideActive,
              onTap: () {
                HapticFeedback.selectionClick();
                Navigator.push(
                    context,
                    MaterialPageRoute(
                        builder: (_) => LocationScreen(
                              serviceType: 'ride',
                              pickupAddress:
                                  _pickup.isNotEmpty ? _pickup : null,
                              pickupLat: _pickupLat,
                              pickupLng: _pickupLng,
                            )));
              },
            )),
          if (rideCats.isNotEmpty && parcelCats.isNotEmpty) const SizedBox(width: 14),
          // ── Parcel card — reflect admin toggle ──
          if (parcelCats.isNotEmpty)
            Expanded(
                child: _buildServiceCard(
              imageUrl: 'https://oyster-app-9e9cd.ondigitalocean.app/static/vehicles/parcel_bike.png',
              fallbackIcon: Icons.local_shipping_rounded,
              title: 'Parcel',
              subtitle: 'Bike · Truck · Van',
              accent: const Color(0xFF059669),
              isActive: isParcelActive,
              onTap: () {
                HapticFeedback.selectionClick();
                Navigator.push(
                    context,
                    MaterialPageRoute(
                        builder: (_) => LocationScreen(
                              serviceType: 'parcel',
                              pickupAddress:
                                  _pickup.isNotEmpty ? _pickup : null,
                              pickupLat: _pickupLat,
                              pickupLng: _pickupLng,
                            )));
              },
            )),
        ]),
      ]),
    );
  }

  Widget _buildServiceCard({
    required String imageUrl,
    required IconData fallbackIcon,
    required String title,
    required String subtitle,
    required Color accent,
    required VoidCallback onTap,
    bool isActive = true,
  }) {
    return GestureDetector(
      onTap: isActive ? onTap : () {
        ScaffoldMessenger.of(context).showSnackBar(SnackBar(
          content: Text('$title service is currently under maintenance or unavailable in your area.'),
          backgroundColor: Colors.redAccent,
          behavior: SnackBarBehavior.floating,
          duration: const Duration(seconds: 2),
        ));
      },
      child: Container(
        height: 158,
        decoration: BoxDecoration(
          color: Colors.white,
          borderRadius: BorderRadius.circular(20),
          border: Border.all(color: isActive ? accent.withValues(alpha: 0.12) : Colors.grey.withValues(alpha: 0.2), width: 1),
          boxShadow: [
            if (isActive) BoxShadow(color: accent.withValues(alpha: 0.10), blurRadius: 20, offset: const Offset(0, 8)),
            BoxShadow(color: Colors.black.withValues(alpha: 0.04), blurRadius: 6, offset: const Offset(0, 2)),
          ],
        ),
        child: ClipRRect(
          borderRadius: BorderRadius.circular(20),
          child: Stack(children: [
            // Subtle tinted background
            Positioned.fill(
              child: Container(
                foregroundDecoration: !isActive ? const BoxDecoration(color: Colors.white60, backgroundBlendMode: BlendMode.saturation) : null,
                decoration: BoxDecoration(
                  gradient: LinearGradient(
                    colors: [Colors.white, isActive ? accent.withValues(alpha: 0.04) : Colors.grey.withValues(alpha: 0.05)],
                    begin: Alignment.topLeft,
                    end: Alignment.bottomRight,
                  ),
                ),
              ),
            ),
            // Vehicle real image — right side, bottom-anchored
            Positioned(
              right: -6,
              bottom: -4,
              child: Opacity(
                opacity: isActive ? 1.0 : 0.4,
                child: SizedBox(
                  width: 118,
                  height: 118,
                  child: Image.network(
                    imageUrl,
                    fit: BoxFit.contain,
                    errorBuilder: (_, __, ___) => Icon(
                      fallbackIcon,
                      size: 88,
                      color: accent.withValues(alpha: 0.10),
                    ),
                  ),
                ),
              ),
            ),
            // Content — left side
            Padding(
              padding: const EdgeInsets.fromLTRB(18, 16, 18, 16),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  // Category pill
                  Container(
                    padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 4),
                    decoration: BoxDecoration(
                      color: accent.withValues(alpha: 0.10),
                      borderRadius: BorderRadius.circular(8),
                    ),
                    child: Text(
                      subtitle,
                      style: GoogleFonts.poppins(
                        fontSize: 10,
                        fontWeight: FontWeight.w400,
                        color: accent,
                      ),
                    ),
                  ),
                  const Spacer(),
                  // Title
                  Text(
                    title,
                    style: GoogleFonts.poppins(
                      fontSize: 26,
                      fontWeight: FontWeight.w500,
                      color: JT.textPrimary,
                      letterSpacing: -0.5,
                      height: 1,
                    ),
                  ),
                  const SizedBox(height: 10),
                  // CTA button
                  Container(
                    padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 6),
                    decoration: BoxDecoration(
                      gradient: LinearGradient(
                        colors: [accent, accent.withValues(alpha: 0.80)],
                        begin: Alignment.centerLeft,
                        end: Alignment.centerRight,
                      ),
                      borderRadius: BorderRadius.circular(20),
                    ),
                    child: Row(mainAxisSize: MainAxisSize.min, children: [
                      Text('Book Now',
                          style: GoogleFonts.poppins(
                              color: Colors.white,
                              fontSize: 11,
                              fontWeight: FontWeight.w400)),
                      const SizedBox(width: 4),
                      const Icon(Icons.arrow_forward_rounded, color: Colors.white, size: 12),
                    ]),
                  ),
                ],
              ),
            ),
          ]),
        ),
      ),
    );
  }

  void onServiceTap(String serviceKey) {
    if (serviceKey.contains('parcel')) {
      Navigator.push(
          context,
          MaterialPageRoute(
              builder: (_) => LocationScreen(
                    serviceType: 'parcel',
                    pickupAddress: _pickup.isNotEmpty ? _pickup : null,
                    pickupLat: _pickupLat,
                    pickupLng: _pickupLng,
                  )));
    } else if (serviceKey.contains('pool') ||
        serviceKey.contains('intercity')) {
      Navigator.push(context,
          MaterialPageRoute(builder: (_) => const IntercityBookingScreen()));
    } else {
      _openSearch();
    }
  }

  Widget dynamicServiceCard({
    required String title,
    required String emoji,
    required String subtitle,
    required VoidCallback onTap,
    String imageUrl = '',
  }) {
    final style = _vehicleStyle(title);
    final iconData = style['icon'] as IconData;
    final gradColors = style['gradient'] as List<Color>;
    return GestureDetector(
      onTap: onTap,
      child: Container(
        padding: const EdgeInsets.fromLTRB(14, 14, 10, 12),
        decoration: BoxDecoration(
          color: Colors.white,
          borderRadius: BorderRadius.circular(20),
          border: Border.all(color: const Color(0xFFDCE7F5)),
          boxShadow: [
            BoxShadow(
                color: Colors.black.withValues(alpha: 0.05),
                blurRadius: 16,
                offset: const Offset(0, 5))
          ],
        ),
        child: Stack(children: [
          Positioned(
            right: -8,
            top: -8,
            child: imageUrl.isNotEmpty
                ? ClipRRect(
                    borderRadius: BorderRadius.circular(8),
                    child: Image.network(imageUrl,
                        width: 64,
                        height: 64,
                        fit: BoxFit.cover,
                        errorBuilder: (_, __, ___) => Icon(iconData,
                            size: 72,
                            color: Colors.white.withValues(alpha: 0.1))))
                : Icon(iconData,
                    size: 72, color: gradColors.first.withValues(alpha: 0.08)),
          ),
          Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Container(
              width: 36,
              height: 36,
              decoration: BoxDecoration(
                color: gradColors.first.withValues(alpha: 0.10),
                borderRadius: BorderRadius.circular(10),
              ),
              child: Icon(iconData, size: 19, color: gradColors.first),
            ),
            const Spacer(),
            if (subtitle.isNotEmpty) ...[
              Text(subtitle,
                  style: GoogleFonts.poppins(
                      fontSize: 10,
                      color: JT.textSecondary,
                      fontWeight: FontWeight.w500),
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis),
              const SizedBox(height: 2),
            ],
            Text(title,
                style: GoogleFonts.poppins(
                    fontSize: 13,
                    fontWeight: FontWeight.w400,
                    color: JT.textPrimary),
                maxLines: 2,
                overflow: TextOverflow.ellipsis),
          ]),
        ]),
      ),
    );
  }

  Widget featuredCard({
    required String subtitle,
    required String title,
    required String emoji,
    required VoidCallback onTap,
    bool tall = false,
    IconData icon = Icons.directions_car_filled_rounded,
    List<Color> gradient = const [JT.primary, Color(0xFF4FA9FF)],
  }) {
    return GestureDetector(
      onTap: onTap,
      child: Container(
        height: tall ? 172 : 148,
        padding: const EdgeInsets.fromLTRB(16, 16, 12, 14),
        decoration: BoxDecoration(
          color: Colors.white,
          borderRadius: BorderRadius.circular(20),
          border: Border.all(color: const Color(0xFFDCE7F5)),
          boxShadow: [
            BoxShadow(
                color: Colors.black.withValues(alpha: 0.05),
                blurRadius: 18,
                offset: const Offset(0, 6))
          ],
        ),
        child: Stack(children: [
          Positioned(
              right: -10,
              top: -10,
              child: Icon(icon,
                  size: 90, color: gradient.first.withValues(alpha: 0.08))),
          Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Container(
              width: 38,
              height: 38,
              decoration: BoxDecoration(
                color: gradient.first.withValues(alpha: 0.10),
                borderRadius: BorderRadius.circular(11),
              ),
              child: Icon(icon, size: 20, color: gradient.first),
            ),
            const Spacer(),
            if (subtitle.isNotEmpty) ...[
              Text(subtitle,
                  style: GoogleFonts.poppins(
                      fontSize: 11,
                      color: JT.textSecondary,
                      fontWeight: FontWeight.w500)),
              const SizedBox(height: 3),
            ],
            Text(title,
                style: GoogleFonts.poppins(
                    fontSize: 15,
                    fontWeight: FontWeight.w400,
                    color: JT.textPrimary),
                maxLines: 2,
                overflow: TextOverflow.ellipsis),
          ]),
        ]),
      ),
    );
  }

  // ── QUICK ACCESS STRIP (Bike / Auto / Car / Parcel) ──────────────────────
  Widget buildExploreSection(bool isDark) {
    // Static quick-access chips — always shown, fast tap to book
    final chips = <Map<String, dynamic>>[
      {
        'name': 'Bike',
        'icon': Icons.electric_bike_rounded,
        'color': const Color(0xFF2D8CFF),
        'type': 'ride'
      },
      {
        'name': 'Auto',
        'icon': Icons.electric_rickshaw_rounded,
        'color': const Color(0xFF2D8CFF),
        'type': 'ride'
      },
      {
        'name': 'Car',
        'icon': Icons.directions_car_filled_rounded,
        'color': const Color(0xFF2D8CFF),
        'type': 'ride'
      },
      {
        'name': 'Parcel Bike',
        'icon': Icons.inventory_2_rounded,
        'color': const Color(0xFF5BABFF),
        'type': 'parcel',
        'vehicleKey': 'bike_parcel'
      },
      {
        'name': 'Mini Truck',
        'icon': Icons.local_shipping_rounded,
        'color': const Color(0xFF5BABFF),
        'type': 'parcel',
        'vehicleKey': 'tata_ace'
      },
      {
        'name': 'Pickup Van',
        'icon': Icons.fire_truck_rounded,
        'color': const Color(0xFF5BABFF),
        'type': 'parcel',
        'vehicleKey': 'pickup_truck'
      },
    ];

    return Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
      Padding(
        padding: const EdgeInsets.fromLTRB(16, 22, 16, 0),
        child: Text('Quick Book',
            style: GoogleFonts.poppins(
                fontSize: 15,
                fontWeight: FontWeight.w400,
                color: JT.textPrimary)),
      ),
      const SizedBox(height: 12),
      SizedBox(
        height: 90,
        child: ListView.builder(
          scrollDirection: Axis.horizontal,
          padding: const EdgeInsets.symmetric(horizontal: 12),
          itemCount: chips.length,
          itemBuilder: (_, i) {
            final item = chips[i];
            final name = item['name'] as String;
            final icon = item['icon'] as IconData;
            final color = item['color'] as Color;
            final type = item['type'] as String;
            return GestureDetector(
              onTap: () {
                HapticFeedback.selectionClick();
                if (type == 'parcel') {
                  Navigator.push(
                      context,
                      MaterialPageRoute(
                          builder: (_) => LocationScreen(
                                serviceType: 'parcel',
                                pickupAddress:
                                    _pickup.isNotEmpty ? _pickup : null,
                                pickupLat: _pickupLat,
                                pickupLng: _pickupLng,
                              )));
                } else {
                  _openSearch();
                }
              },
              child: Container(
                width: 74,
                margin: const EdgeInsets.symmetric(horizontal: 4),
                child: Column(children: [
                  Container(
                    width: 58,
                    height: 58,
                    decoration: BoxDecoration(
                      color: color.withValues(alpha: 0.10),
                      borderRadius: BorderRadius.circular(18),
                      border: Border.all(
                          color: color.withValues(alpha: 0.25), width: 1.5),
                    ),
                    child: Icon(icon, color: color, size: 26),
                  ),
                  const SizedBox(height: 5),
                  Text(name,
                      style: GoogleFonts.poppins(
                          fontSize: 10,
                          fontWeight: FontWeight.w400,
                          color: JT.textPrimary),
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      textAlign: TextAlign.center),
                ]),
              ),
            );
          },
        ),
      ),
    ]);
  }

  // ── BANNER CAROUSEL ───────────────────────────────────────────────────────
  Widget buildBannerCarousel(bool isDark) {
    return Padding(
      padding: const EdgeInsets.fromLTRB(16, 20, 16, 0),
      child: _banners.isEmpty
          ? _buildStaticPromoBanner(isDark)
          : Column(children: [
              SizedBox(
                height: 140,
                child: PageView.builder(
                  controller: _bannerPageCtrl,
                  onPageChanged: (i) => setState(() => _bannerIndex = i),
                  itemCount: _banners.length,
                  itemBuilder: (_, i) {
                    final b = _banners[i];
                    final imgUrl = b['image_url']?.toString() ?? '';
                    return Container(
                      margin: const EdgeInsets.symmetric(horizontal: 4),
                      decoration: BoxDecoration(
                        borderRadius: BorderRadius.circular(16),
                        color: Colors.white,
                        border: Border.all(color: const Color(0xFFDCE7F5)),
                        boxShadow: JT.cardShadow,
                      ),
                      child: imgUrl.isNotEmpty
                          ? ClipRRect(
                              borderRadius: BorderRadius.circular(16),
                              child: Image.network(imgUrl,
                                  fit: BoxFit.cover,
                                  errorBuilder: (_, __, ___) =>
                                      _bannerPlaceholder(b)))
                          : _bannerPlaceholder(b),
                    );
                  },
                ),
              ),
              if (_banners.length > 1) ...[
                const SizedBox(height: 8),
                Row(
                    mainAxisAlignment: MainAxisAlignment.center,
                    children: List.generate(
                        _banners.length,
                        (i) => Container(
                              margin: const EdgeInsets.symmetric(horizontal: 3),
                              width: _bannerIndex == i ? 16 : 6,
                              height: 6,
                              decoration: BoxDecoration(
                                color: _bannerIndex == i
                                    ? JT.primary
                                    : JT.primary.withValues(alpha: 0.3),
                                borderRadius: BorderRadius.circular(3),
                              ),
                            ))),
              ],
            ]),
    );
  }

  Widget _bannerPlaceholder(Map<String, dynamic> b) {
    return Container(
      padding: const EdgeInsets.all(20),
      decoration: BoxDecoration(
        borderRadius: BorderRadius.circular(16),
        color: JT.primary,
      ),
      child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          mainAxisAlignment: MainAxisAlignment.center,
          children: [
            Text(b['title']?.toString() ?? 'Special Offer',
                style: GoogleFonts.poppins(
                    color: Colors.white,
                    fontSize: 16,
                    fontWeight: FontWeight.w400)),
            const SizedBox(height: 4),
            Text('Tap to learn more',
                style:
                    GoogleFonts.poppins(color: Colors.white70, fontSize: 12)),
          ]),
    );
  }

  Widget _buildStaticPromoBanner(bool isDark) {
    return Container(
      height: 130,
      decoration: BoxDecoration(
        borderRadius: BorderRadius.circular(16),
        color: Colors.white,
        border: Border.all(color: const Color(0xFFDCE7F5)),
        boxShadow: JT.cardShadow,
      ),
      padding: const EdgeInsets.all(20),
      child: Row(children: [
        Expanded(
            child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                mainAxisAlignment: MainAxisAlignment.center,
                children: [
              JT.logoBlue(height: 28),
              const SizedBox(height: 8),
              Text('Safe, fast and affordable rides',
                  style: GoogleFonts.poppins(
                      color: JT.textSecondary, fontSize: 12)),
              const SizedBox(height: 10),
              GestureDetector(
                onTap: _openSearch,
                child: Container(
                  padding:
                      const EdgeInsets.symmetric(horizontal: 14, vertical: 8),
                  decoration: BoxDecoration(
                      color: JT.primary,
                      borderRadius: BorderRadius.circular(20)),
                  child: Text('Book Now',
                      style: GoogleFonts.poppins(
                          color: Colors.white,
                          fontSize: 12,
                          fontWeight: FontWeight.w400)),
                ),
              ),
            ])),
        Icon(Icons.directions_car_filled_rounded,
            size: 72, color: JT.primary.withValues(alpha: 0.12)),
      ]),
    );
  }

  // ── SAVED PLACES ──────────────────────────────────────────────────────────
  Widget buildSavedPlaces(bool isDark) {
    if (_savedPlaces.isEmpty) return const SizedBox.shrink();
    return Padding(
      padding: const EdgeInsets.fromLTRB(16, 20, 16, 0),
      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Text('Quick Access', style: JT.h3),
        const SizedBox(height: 10),
        Row(
            children: _savedPlaces.take(2).map((place) {
          final label = place['label']?.toString() ?? '';
          final address = place['address']?.toString() ?? '';
          final icon =
              label == 'Home' ? Icons.home_rounded : Icons.work_rounded;
          final isFirst = _savedPlaces.indexOf(place) == 0;
          return Expanded(
              child: GestureDetector(
            onTap: () {
              final lat =
                  double.tryParse(place['lat']?.toString() ?? '0') ?? 0.0;
              final lng =
                  double.tryParse(place['lng']?.toString() ?? '0') ?? 0.0;
              Navigator.push(
                  context,
                  MaterialPageRoute(
                      builder: (_) => BookingScreen(
                            pickup: _pickup,
                            destination: address,
                            pickupLat: _pickupLat,
                            pickupLng: _pickupLng,
                            destLat: lat != 0 ? lat : 17.385,
                            destLng: lng != 0 ? lng : 78.4867,
                          )));
            },
            child: Container(
              margin: EdgeInsets.only(right: isFirst ? 8 : 0),
              padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 12),
              decoration: BoxDecoration(
                color: isDark ? JT.surface : JT.surface,
                borderRadius: BorderRadius.circular(14),
                boxShadow: JT.cardShadow,
              ),
              child: Row(children: [
                Icon(icon, color: JT.primary, size: 18),
                const SizedBox(width: 8),
                Expanded(
                    child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                      Text(label,
                          style: GoogleFonts.poppins(
                              fontSize: 12,
                              fontWeight: FontWeight.w500,
                              color: JT.textPrimary)),
                      Text(address,
                          style: GoogleFonts.poppins(
                              fontSize: 10,
                              color:
                                  isDark ? Colors.white54 : JT.textSecondary),
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis),
                    ])),
              ]),
            ),
          ));
        }).toList()),
      ]),
    );
  }

  // ── RECENT TRIPS ──────────────────────────────────────────────────────────
  Widget buildRecentTrips(bool isDark) {
    if (_recentTrips.isEmpty) return const SizedBox.shrink();
    return Padding(
      padding: const EdgeInsets.fromLTRB(16, 20, 16, 0),
      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Row(children: [
          Text('Recent', style: JT.h3),
          const Spacer(),
          GestureDetector(
            onTap: () => Navigator.push(context,
                MaterialPageRoute(builder: (_) => const TripsHistoryScreen())),
            child: Text('See all',
                style: GoogleFonts.poppins(
                    fontSize: 12,
                    color: JT.primary,
                    fontWeight: FontWeight.w400)),
          ),
        ]),
        const SizedBox(height: 10),
        ..._recentTrips.take(3).map((trip) {
          final dest = trip['destinationAddress']?.toString() ??
              trip['destination_address']?.toString() ??
              'Unknown';
          final fare = trip['actualFare']?.toString() ??
              trip['actual_fare']?.toString() ??
              '';
          return GestureDetector(
            onTap: _openSearch,
            child: Container(
              margin: const EdgeInsets.only(bottom: 8),
              padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 12),
              decoration: BoxDecoration(
                color: isDark ? JT.surface : JT.surface,
                borderRadius: BorderRadius.circular(12),
                border: Border.all(color: isDark ? Colors.white12 : JT.border),
                boxShadow: isDark ? null : JT.cardShadow,
              ),
              child: Row(children: [
                Icon(Icons.history_rounded, color: JT.primary, size: 18),
                const SizedBox(width: 12),
                Expanded(
                    child: Text(dest.split(',').first,
                        style: GoogleFonts.poppins(
                            fontSize: 13,
                            fontWeight: FontWeight.w500,
                            color: JT.textPrimary),
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis)),
                if (fare.isNotEmpty)
                  Text('₹$fare',
                      style: GoogleFonts.poppins(
                          fontSize: 12, color: JT.textSecondary)),
              ]),
            ),
          );
        }),
      ]),
    );
  }

  // ── ACTIVE TRIP BANNER ───────────────────────────────────────────────────
  Widget _buildActiveTripBanner(bool isDark) {
    final trip = _activeTrip!;
    final status = trip['currentStatus']?.toString() ?? 'accepted';
    final tripId = trip['id']?.toString() ?? '';
    final driverName = trip['driverName']?.toString() ?? 'your Pilot';
    final dest = trip['destinationAddress']?.toString() ?? 'destination';
    final isSearching = status == 'searching';

    final statusLabel = {
          'searching': 'Finding a Pilot...',
          'accepted': 'Pilot is on the way',
          'driver_assigned': 'Pilot assigned',
          'arrived': 'Pilot has arrived!',
          'in_progress': 'Ride in progress',
        }[status] ??
        'Ride active';

    final isArrived = status == 'arrived';
    final bannerColor = isSearching
        ? JT.primaryDark
        : isArrived
            ? const Color(0xFF1A6FDB)
            : JT.primary;

    return Container(
      margin: const EdgeInsets.fromLTRB(16, 12, 16, 4),
      padding: const EdgeInsets.all(14),
      decoration: BoxDecoration(
        color: Colors.white,
        borderRadius: BorderRadius.circular(18),
        border: Border.all(color: bannerColor.withValues(alpha: 0.20)),
        boxShadow: [
          BoxShadow(
              color: Colors.black.withValues(alpha: 0.05),
              blurRadius: 16,
              offset: const Offset(0, 4))
        ],
      ),
      child: Row(children: [
        Container(
          width: 40,
          height: 40,
          decoration: BoxDecoration(
              color: bannerColor.withValues(alpha: 0.10),
              shape: BoxShape.circle),
          child: Icon(
              isSearching ? Icons.search_rounded : Icons.navigation_rounded,
              color: bannerColor,
              size: 22),
        ),
        const SizedBox(width: 12),
        Expanded(
            child:
                Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Text(statusLabel,
              style: GoogleFonts.poppins(
                  color: JT.textPrimary,
                  fontWeight: FontWeight.w500,
                  fontSize: 14)),
          Text(
              isSearching
                  ? 'Looking for nearby pilots...'
                  : '$driverName → ${dest.length > 28 ? '${dest.substring(0, 26)}...' : dest}',
              style: GoogleFonts.poppins(
                  color: JT.textSecondary,
                  fontSize: 11,
                  fontWeight: FontWeight.w500)),
        ])),
        if (isSearching)
          // Cancel button for stuck searching trips
          GestureDetector(
            onTap: () async {
              final confirm = await showDialog<bool>(
                context: context,
                builder: (ctx) => AlertDialog(
                  backgroundColor: JT.surface,
                  shape: RoundedRectangleBorder(
                      borderRadius: BorderRadius.circular(16)),
                  title: Text('Cancel Ride?',
                      style: GoogleFonts.poppins(
                          fontWeight: FontWeight.w400,
                          color: JT.textPrimary,
                          fontSize: 16)),
                  content: Text(
                      'No pilot found yet. Do you want to cancel this request?',
                      style: GoogleFonts.poppins(
                          color: JT.textSecondary, fontSize: 13)),
                  actions: [
                    TextButton(
                        onPressed: () => Navigator.pop(ctx, false),
                        child: Text('Wait',
                            style:
                                GoogleFonts.poppins(color: JT.textSecondary))),
                    ElevatedButton(
                        style: ElevatedButton.styleFrom(
                            backgroundColor: JT.primaryDark,
                            foregroundColor: Colors.white,
                            shape: RoundedRectangleBorder(
                                borderRadius: BorderRadius.circular(10))),
                        onPressed: () => Navigator.pop(ctx, true),
                        child: Text('Cancel Ride',
                            style: GoogleFonts.poppins(
                                fontWeight: FontWeight.w500))),
                  ],
                ),
              );
              if (confirm == true && mounted) {
                try {
                  final h = await AuthService.getHeaders();
                  await http.post(Uri.parse(ApiConfig.cancelTrip),
                      headers: h,
                      body: jsonEncode(
                          {'tripId': tripId, 'reason': 'No pilot found'}));
                } catch (_) {}
                if (mounted) setState(() => _activeTrip = null);
              }
            },
            child: Container(
              padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 7),
              decoration: BoxDecoration(
                color: JT.primaryDark.withValues(alpha: 0.08),
                borderRadius: BorderRadius.circular(10),
              ),
              child: Text('Cancel',
                  style: GoogleFonts.poppins(
                      color: JT.primaryDark,
                      fontWeight: FontWeight.w400,
                      fontSize: 12)),
            ),
          )
        else
          GestureDetector(
            onTap: () {
              if (tripId.isEmpty) return;
              Navigator.pushReplacement(
                  context,
                  MaterialPageRoute(
                      builder: (_) => TrackingScreen(tripId: tripId)));
            },
            child: Container(
              padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 7),
              decoration: BoxDecoration(
                color: JT.primary.withValues(alpha: 0.10),
                borderRadius: BorderRadius.circular(10),
              ),
              child: Text('Track →',
                  style: GoogleFonts.poppins(
                      color: JT.primary,
                      fontWeight: FontWeight.w400,
                      fontSize: 12)),
            ),
          ),
      ]),
    );
  }

  // Deleted stray code

  // ── DRAWER ───────────────────────────────────────────────────────────────
  Widget _buildDrawer(bool isDark) {
    final drawerBg = isDark ? _darkBg : JT.bg;
    final textColor = JT.textPrimary;
    return Drawer(
      backgroundColor: drawerBg,
      child: SafeArea(
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Container(
            padding: const EdgeInsets.fromLTRB(20, 24, 20, 20),
            decoration: BoxDecoration(
              color: JT.bgSoft,
              border: const Border(bottom: BorderSide(color: JT.border)),
            ),
            child:
                Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              CircleAvatar(
                radius: 30,
                backgroundColor: JT.surfaceAlt,
                child: Text(
                  _userName.isNotEmpty ? _userName[0].toUpperCase() : 'U',
                  style: GoogleFonts.poppins(
                      color: JT.primary,
                      fontSize: 24,
                      fontWeight: FontWeight.w500),
                ),
              ),
              const SizedBox(height: 12),
              Text(_userName, style: JT.h2),
              Text(_userPhone, style: JT.body),
            ]),
          ),
          Divider(
              color: isDark ? const Color(0xFF334155) : JT.border,
              thickness: 1),
          _drawerItem(Icons.history_rounded, 'My Trips', textColor, () {
            Navigator.pop(context);
            Navigator.push(context,
                MaterialPageRoute(builder: (_) => const TripsHistoryScreen()));
          }),
          _drawerItem(Icons.account_balance_wallet_rounded, 'Wallet', textColor,
              () {
            Navigator.pop(context);
            Navigator.push(context,
                MaterialPageRoute(builder: (_) => const WalletScreen()));
          }),
          _drawerItem(Icons.local_offer_rounded, 'Offers', textColor, () {
            Navigator.pop(context);
            Navigator.push(context,
                MaterialPageRoute(builder: (_) => const OffersScreen()));
          }),
          _drawerItem(Icons.bookmark_rounded, 'Saved Places', textColor, () {
            Navigator.pop(context);
            Navigator.push(context,
                MaterialPageRoute(builder: (_) => const SavedPlacesScreen()));
          }),
          _drawerItem(Icons.people_alt_rounded, 'Refer & Earn', textColor, () {
            Navigator.pop(context);
            Navigator.push(context,
                MaterialPageRoute(builder: (_) => const ReferralScreen()));
          }),
          _drawerItem(
              Icons.directions_car_outlined, 'Intercity Pool', textColor, () {
            Navigator.pop(context);
            Navigator.push(
                context,
                MaterialPageRoute(
                    builder: (_) => const OutstationPoolScreen()));
          }),
          _drawerItem(Icons.business_center_rounded, 'B2B Business', textColor,
              () {
            Navigator.pop(context);
            Navigator.push(context,
                MaterialPageRoute(builder: (_) => const B2BLoginScreen()));
          }),
          _drawerItem(Icons.support_agent_rounded, 'Support', textColor, () {
            Navigator.pop(context);
            Navigator.push(context,
                MaterialPageRoute(builder: (_) => const SupportChatScreen()));
          }),
          const Spacer(),
          _drawerItem(Icons.person_rounded, 'Profile', textColor, () {
            Navigator.pop(context);
            Navigator.push(context,
                MaterialPageRoute(builder: (_) => const ProfileScreen()));
          }),
          const SizedBox(height: 16),
        ]),
      ),
    );
  }

  Widget _drawerItem(
      IconData icon, String label, Color textColor, VoidCallback onTap) {
    return ListTile(
      leading: Icon(icon, color: JT.primary, size: 22),
      title: Text(label,
          style: GoogleFonts.poppins(
              color: textColor, fontSize: 15, fontWeight: FontWeight.w500)),
      onTap: onTap,
      dense: true,
    );
  }
}

// ── PLACE SEARCH SHEET ────────────────────────────────────────────────────
class _PlaceSearchSheet extends StatefulWidget {
  final double pickupLat;
  final double pickupLng;
  final void Function(String name, double lat, double lng) onPlaceSelected;

  const _PlaceSearchSheet({
    required this.pickupLat,
    required this.pickupLng,
    required this.onPlaceSelected,
  });

  @override
  State<_PlaceSearchSheet> createState() => _PlaceSearchSheetState();
}

class _PlaceSearchSheetState extends State<_PlaceSearchSheet> {
  final TextEditingController _ctrl = TextEditingController();
  List<Map<String, dynamic>> _results = [];
  List<Map<String, dynamic>> _nearby = [];
  List<Map<String, dynamic>> _popular = [];
  bool _loading = false;
  Timer? _debounce;

  static const Color _primary = JT.primary;

  @override
  void initState() {
    super.initState();
    _fetchPopularLocations();
    _fetchNearby();
  }

  void _openMapPicker() async {
    Navigator.pop(context);
    final result = await Navigator.push<PickedLocation>(
      context,
      MaterialPageRoute(
          builder: (_) => MapLocationPicker(
                title: 'Select Destination',
                initialLat: widget.pickupLat,
                initialLng: widget.pickupLng,
              )),
    );
    if (result != null) {
      widget.onPlaceSelected(result.address, result.lat, result.lng);
    }
  }

  Future<void> _fetchPopularLocations() async {
    try {
      final r = await http.get(Uri.parse(
          '${ApiConfig.baseUrl}/api/app/popular-locations?city=Vijayawada'));
      if (r.statusCode == 200) {
        final data = jsonDecode(r.body) as Map<String, dynamic>;
        final list = (data['locations'] as List<dynamic>? ?? [])
            .map((x) => Map<String, dynamic>.from(x as Map))
            .map((x) => {
                  'name': (x['name'] ?? '').toString(),
                  'lat': double.tryParse(
                          (x['lat'] ?? x['latitude'] ?? 0).toString()) ??
                      0.0,
                  'lng': double.tryParse(
                          (x['lng'] ?? x['longitude'] ?? 0).toString()) ??
                      0.0,
                })
            .where((x) => (x['name'] as String).isNotEmpty)
            .toList();
        if (mounted && list.isNotEmpty) {
          setState(() => _popular = list);
          return;
        }
      }
    } catch (_) {}
    if (mounted && _popular.isEmpty) {
      setState(() => _popular = [
            {'name': 'Benz Circle', 'lat': 16.5062, 'lng': 80.6480},
            {
              'name': 'Vijayawada Railway Station',
              'lat': 16.5175,
              'lng': 80.6400
            },
            {'name': 'Vijayawada Bus Stand', 'lat': 16.5179, 'lng': 80.6238},
            {'name': 'Balaji Bus Stand', 'lat': 16.5106, 'lng': 80.6248},
            {'name': 'Kanaka Durga Temple', 'lat': 16.5176, 'lng': 80.6121},
            {'name': 'Gannavaram Airport', 'lat': 16.5304, 'lng': 80.7968},
            {'name': 'Governorpet', 'lat': 16.5135, 'lng': 80.6346},
            {'name': 'Patamata', 'lat': 16.4883, 'lng': 80.6681},
          ]);
    }
  }

  // Fetch actual nearby places based on real GPS coordinates
  Future<void> _fetchNearby() async {
    final lat = widget.pickupLat;
    final lng = widget.pickupLng;
    if (lat == 0.0 && lng == 0.0) return;
    try {
      final headers = await AuthService.getHeaders();
      final res = await http.get(
        Uri.parse('${ApiConfig.placesNearby}?lat=$lat&lng=$lng&radius=3000'),
        headers: headers,
      ).timeout(const Duration(seconds: 6));
      if (res.statusCode == 200) {
        final data = jsonDecode(res.body) as Map<String, dynamic>;
        final places = (data['places'] as List<dynamic>?) ?? [];
        if (mounted && places.isNotEmpty) {
          setState(() {
            _nearby = places
                .map((p) => <String, dynamic>{
                      'name': p['name']?.toString() ?? '',
                      'lat': (p['lat'] as num?)?.toDouble() ?? 0.0,
                      'lng': (p['lng'] as num?)?.toDouble() ?? 0.0,
                    })
                .where((r) => (r['name'] as String).isNotEmpty)
                .toList();
          });
        }
      }
    } catch (_) {}
  }

  Future<void> _search(String query) async {
    if (query.length < 3) {
      setState(() {
        _results = [];
        _loading = false;
      });
      return;
    }
    setState(() => _loading = true);
    try {
      final headers = await AuthService.getHeaders();
      final lat = widget.pickupLat;
      final lng = widget.pickupLng;
      final qp = StringBuffer('?query=${Uri.encodeComponent(query)}');
      if (lat != 0.0 && lng != 0.0) qp.write('&lat=$lat&lng=$lng');
      final r = await http.get(
        Uri.parse('${ApiConfig.placesAutocomplete}$qp'),
        headers: headers,
      ).timeout(const Duration(seconds: 6));
      if (r.statusCode == 200) {
        final data = jsonDecode(r.body) as Map<String, dynamic>;
        final preds = (data['predictions'] as List<dynamic>?) ?? [];
        setState(() {
          _results = preds
              .map((p) => <String, dynamic>{
                    'name': p['fullDescription']?.toString() ??
                        p['mainText']?.toString() ?? '',
                    'placeId': p['placeId']?.toString() ?? '',
                    'lat': (p['lat'] as num?)?.toDouble() ?? 0.0,
                    'lng': (p['lng'] as num?)?.toDouble() ?? 0.0,
                  })
              .where((r) => (r['name'] as String).isNotEmpty)
              .toList();
        });
      }
    } catch (_) {}
    if (mounted) setState(() => _loading = false);
  }

  Future<void> _resolveAndSelect(Map<String, dynamic> p) async {
    var name = p['name']?.toString() ?? '';
    var lat = (p['lat'] as num?)?.toDouble() ?? 0.0;
    var lng = (p['lng'] as num?)?.toDouble() ?? 0.0;
    final placeId = p['placeId']?.toString() ?? '';
    if ((lat == 0.0 || lng == 0.0) &&
        placeId.isNotEmpty &&
        !placeId.startsWith('local:')) {
      try {
        final headers = await AuthService.getHeaders();
        final r = await http
            .get(
              Uri.parse(
                  '${ApiConfig.placeDetails}?placeId=${Uri.encodeComponent(placeId)}'),
              headers: headers,
            )
            .timeout(const Duration(seconds: 6));
        if (r.statusCode == 200) {
          final d = jsonDecode(r.body) as Map<String, dynamic>;
          lat = (d['lat'] as num?)?.toDouble() ?? 0.0;
          lng = (d['lng'] as num?)?.toDouble() ?? 0.0;
          name = d['address']?.toString() ?? name;
        }
      } catch (_) {}
    }
    if (lat != 0.0 && lng != 0.0) {
      Navigator.pop(context);
      widget.onPlaceSelected(name, lat, lng);
    }
  }

  @override
  void dispose() {
    _ctrl.dispose();
    _debounce?.cancel();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final query = _ctrl.text;
    final items = query.length >= 3 ? _results : _nearby;

    const sheetBg = Colors.white;
    const inputBg = Color(0xFFF5F8FF);
    const textColor = JT.textPrimary;
    const subColor = Color(0xFF94A3B8);
    return Padding(
      padding:
          EdgeInsets.only(bottom: MediaQuery.of(context).viewInsets.bottom),
      child: Container(
        color: sheetBg,
        child: Column(mainAxisSize: MainAxisSize.min, children: [
          Container(
            width: 36,
            height: 4,
            margin: const EdgeInsets.only(top: 10, bottom: 14),
            decoration: BoxDecoration(
              color: const Color(0xFFDCE9FF),
              borderRadius: BorderRadius.circular(2),
            ),
          ),
          Padding(
            padding: const EdgeInsets.symmetric(horizontal: 16),
            child: TextField(
              controller: _ctrl,
              autofocus: true,
              style: GoogleFonts.poppins(color: textColor, fontSize: 15),
              decoration: InputDecoration(
                hintText: 'Search destination...',
                hintStyle: GoogleFonts.poppins(color: subColor, fontSize: 15),
                prefixIcon: const Icon(Icons.search, color: _primary),
                suffixIcon: query.isNotEmpty
                    ? IconButton(
                        icon: Icon(Icons.clear, color: subColor),
                        onPressed: () => setState(() {
                              _ctrl.clear();
                              _results = [];
                            }))
                    : null,
                border: OutlineInputBorder(
                    borderRadius: BorderRadius.circular(14),
                    borderSide: BorderSide.none),
                filled: true,
                fillColor: inputBg,
                contentPadding: const EdgeInsets.symmetric(vertical: 14),
              ),
              onChanged: (v) {
                _debounce?.cancel();
                _debounce =
                    Timer(const Duration(milliseconds: 400), () => _search(v));
                setState(() {});
              },
            ),
          ),
          // Pick on Map option
          Padding(
            padding: const EdgeInsets.fromLTRB(16, 10, 16, 0),
            child: GestureDetector(
              onTap: _openMapPicker,
              child: Container(
                padding:
                    const EdgeInsets.symmetric(horizontal: 14, vertical: 12),
                decoration: BoxDecoration(
                  color: const Color(0xFFF0F7FF),
                  borderRadius: BorderRadius.circular(12),
                  border: Border.all(color: const Color(0xFFDCE9FF)),
                ),
                child: Row(children: [
                  const Icon(Icons.map_rounded, color: _primary, size: 20),
                  const SizedBox(width: 10),
                  Text('Pick on Map',
                      style: GoogleFonts.poppins(
                          fontSize: 14,
                          fontWeight: FontWeight.w400,
                          color: _primary)),
                  const Spacer(),
                  const Icon(Icons.chevron_right_rounded,
                      color: _primary, size: 20),
                ]),
              ),
            ),
          ),
          const SizedBox(height: 8),
          if (_popular.isNotEmpty && query.length < 3)
            Padding(
              padding: const EdgeInsets.fromLTRB(16, 2, 16, 10),
              child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      'Popular Locations',
                      style: GoogleFonts.poppins(
                          fontSize: 12,
                          color: subColor,
                          fontWeight: FontWeight.w400),
                    ),
                    const SizedBox(height: 8),
                    SingleChildScrollView(
                      scrollDirection: Axis.horizontal,
                      child: Row(
                        children: _popular.map((p) {
                          return GestureDetector(
                            onTap: () {
                              Navigator.pop(context);
                              widget.onPlaceSelected(
                                p['name'] as String,
                                (p['lat'] as num?)?.toDouble() ?? 0.0,
                                (p['lng'] as num?)?.toDouble() ?? 0.0,
                              );
                            },
                            child: Container(
                              margin: const EdgeInsets.only(right: 8),
                              padding: const EdgeInsets.symmetric(
                                  horizontal: 12, vertical: 8),
                              decoration: BoxDecoration(
                                color: const Color(0xFFF0F7FF),
                                borderRadius: BorderRadius.circular(20),
                                border:
                                    Border.all(color: const Color(0xFFDCE9FF)),
                              ),
                              child: Row(
                                  mainAxisSize: MainAxisSize.min,
                                  children: [
                                    const Icon(Icons.place_rounded,
                                        color: _primary, size: 14),
                                    const SizedBox(width: 6),
                                    Text(
                                      p['name'] as String,
                                      style: GoogleFonts.poppins(
                                          fontSize: 12,
                                          fontWeight: FontWeight.w400,
                                          color: textColor),
                                    ),
                                  ]),
                            ),
                          );
                        }).toList(),
                      ),
                    ),
                  ]),
            ),
          if (_loading)
            const Padding(
                padding: EdgeInsets.all(16),
                child: CircularProgressIndicator(color: _primary)),
          if (!_loading)
            ConstrainedBox(
              constraints: BoxConstraints(
                  maxHeight: MediaQuery.of(context).size.height * 0.4),
              child: ListView.builder(
                shrinkWrap: true,
                itemCount: items.length + (query.length < 3 ? 1 : 0),
                itemBuilder: (_, i) {
                  if (query.length < 3 && i == 0) {
                    return Padding(
                      padding: const EdgeInsets.fromLTRB(16, 4, 16, 8),
                      child: Text(
                        _nearby.isEmpty
                            ? 'Start typing to search...'
                            : 'Nearby places',
                        style: GoogleFonts.poppins(
                            fontSize: 12,
                            color: subColor,
                            fontWeight: FontWeight.w400),
                      ),
                    );
                  }
                  final item = items[query.length < 3 ? i - 1 : i];
                  return ListTile(
                    leading:
                        const Icon(Icons.location_on_outlined, color: _primary),
                    title: Text(
                      item['name'] as String,
                      style: GoogleFonts.poppins(
                          fontSize: 14,
                          fontWeight: FontWeight.w500,
                          color: textColor),
                      maxLines: 2,
                    ),
                    onTap: () => _resolveAndSelect(item),
                  );
                },
              ),
            ),
          const SizedBox(height: 16),
        ]),
      ),
    );
  }
}

// ── ALL SERVICES SHEET ────────────────────────────────────────────────────
class AllServicesSheet extends StatelessWidget {
  final List<Map<String, dynamic>> vehicleCategories;
  final List<Map<String, dynamic>> activeServices;
  final String pickup;
  final double pickupLat;
  final double pickupLng;
  final void Function(Map<String, dynamic> cat) onServiceTap;

  const AllServicesSheet({
    required this.vehicleCategories,
    required this.activeServices,
    required this.pickup,
    required this.pickupLat,
    required this.pickupLng,
    required this.onServiceTap,
  });


  @override
  Widget build(BuildContext context) {
    // Build services list from active vehicle categories (filtered by admin)
    List<Map<String, dynamic>> services = [];

    if (vehicleCategories.isNotEmpty) {
      services = vehicleCategories
          .map((v) => {
                'id': v['id'],
                'name': v['name'] ?? '',
                'type': v['type'] ?? 'ride',
                'emoji': _emojiForCategory(v['name']?.toString() ?? ''),
                'key':
                    v['name']?.toString().toLowerCase().replaceAll(' ', '_') ??
                        '',
              })
          .toList();
    }

    // Add active platform services that aren't already covered by vehicle categories
    if (activeServices.isNotEmpty) {
      final existingKeys =
          services.map((s) => s['key']?.toString() ?? '').toSet();
      for (final svc in activeServices) {
        final key = svc['key']?.toString() ?? '';
        if (key.isNotEmpty &&
            !existingKeys.any((k) => key.contains(k) || k.contains(key))) {
          services.add({
            'id': null,
            'name': svc['name']?.toString() ?? key,
            'type': svc['category']?.toString() ?? 'ride',
            'emoji': svc['icon']?.toString() ?? '🚗',
            'key': key,
          });
        }
      }
    }

    // If nothing available at all, show empty state
    if (services.isEmpty) {
      services = [
        {
          'id': null,
          'name': 'No services available',
          'type': 'none',
          'emoji': '🔒',
          'key': ''
        }
      ];
    }

    // Group services by category
    final rideServices = services.where((s) {
      final t = s['type']?.toString() ?? '';
      return t == 'ride' &&
          !(s['name']?.toString().toLowerCase().contains('pool') ?? false);
    }).toList();
    final parcelServices = services.where((s) {
      final t = s['type']?.toString() ?? '';
      return t == 'parcel' || t == 'cargo';
    }).toList();
    final poolServices = services.where((s) {
      final t = s['type']?.toString() ?? '';
      final name = s['name']?.toString().toLowerCase() ?? '';
      return name.contains('pool') || name.contains('share') || t == 'pool';
    }).toList();

    return Container(
      padding: const EdgeInsets.only(top: 16, left: 16, right: 16, bottom: 24),
      decoration: const BoxDecoration(
        color: Colors.white,
        borderRadius: BorderRadius.vertical(top: Radius.circular(24)),
      ),
      child: SingleChildScrollView(
        child: Column(mainAxisSize: MainAxisSize.min, children: [
          Container(
            width: 36,
            height: 4,
            decoration: BoxDecoration(
              color: const Color(0xFFDCE9FF),
              borderRadius: BorderRadius.circular(2),
            ),
          ),
          const SizedBox(height: 16),
          Row(mainAxisAlignment: MainAxisAlignment.spaceBetween, children: [
            Text('All Services',
                style: GoogleFonts.poppins(
                    fontSize: 18,
                    fontWeight: FontWeight.w400,
                    color: JT.textPrimary)),
            GestureDetector(
              onTap: () => Navigator.pop(context),
              child: Container(
                width: 32,
                height: 32,
                decoration: const BoxDecoration(
                  color: Color(0xFFF5F8FF),
                  shape: BoxShape.circle,
                ),
                child:
                    const Icon(Icons.close, size: 18, color: Color(0xFF94A3B8)),
              ),
            ),
          ]),
          const SizedBox(height: 20),
          if (rideServices.isNotEmpty) ...[
            _sectionHeader('🚗 Ride'),
            const SizedBox(height: 10),
            _serviceGrid(rideServices),
            const SizedBox(height: 20),
          ],
          if (parcelServices.isNotEmpty) ...[
            _sectionHeader('📦 Parcel & Logistics'),
            const SizedBox(height: 10),
            _serviceGrid(parcelServices),
            const SizedBox(height: 20),
          ],
          if (poolServices.isNotEmpty) ...[
            _sectionHeader('🚐 Car Pool'),
            const SizedBox(height: 10),
            _serviceGrid(poolServices),
          ],
        ]),
      ),
    );
  }

  Widget _sectionHeader(String title) {
    return Align(
      alignment: Alignment.centerLeft,
      child: Text(title,
          style: GoogleFonts.poppins(
              fontSize: 14,
              fontWeight: FontWeight.w500,
              color: JT.textPrimary)),
    );
  }

  Widget _serviceGrid(List<Map<String, dynamic>> items) {
    return GridView.builder(
      shrinkWrap: true,
      physics: const NeverScrollableScrollPhysics(),
      gridDelegate: const SliverGridDelegateWithFixedCrossAxisCount(
        crossAxisCount: 3,
        childAspectRatio: 0.88,
        crossAxisSpacing: 12,
        mainAxisSpacing: 12,
      ),
      itemCount: items.length,
      itemBuilder: (_, i) {
        final s = items[i];
        return GestureDetector(
          onTap: () => onServiceTap(s),
          child: Container(
            decoration: BoxDecoration(
              color: const Color(0xFFF5F8FF),
              borderRadius: BorderRadius.circular(16),
              border: Border.all(color: const Color(0xFFDCE9FF)),
              boxShadow: [
                BoxShadow(
                  color: Colors.black.withValues(alpha: 0.03),
                  blurRadius: 8,
                  offset: const Offset(0, 2),
                ),
              ],
            ),
            child:
                Column(mainAxisAlignment: MainAxisAlignment.center, children: [
              Text(s['emoji'] as String, style: const TextStyle(fontSize: 36)),
              const SizedBox(height: 8),
              Text(
                s['name'] as String,
                style: GoogleFonts.poppins(
                    fontSize: 12,
                    fontWeight: FontWeight.w400,
                    color: JT.textPrimary),
                textAlign: TextAlign.center,
                maxLines: 2,
              ),
            ]),
          ),
        );
      },
    );
  }

  static String _emojiForCategory(String name) {
    final lower = name.toLowerCase();
    if (lower.contains('bike') && lower.contains('parcel')) return '📦';
    if (lower.contains('bike') || lower.contains('moto')) return '🏍️';
    if (lower.contains('auto') && lower.contains('parcel')) return '📦';
    if (lower.contains('auto')) return '🛺';
    if (lower.contains('cargo') ||
        lower.contains('truck') ||
        lower.contains('bolero')) return '🚛';
    if (lower.contains('parcel')) return '📦';
    if (lower.contains('pool') || lower.contains('shar')) return '🚐';
    if (lower.contains('car') || lower.contains('cab')) return '🚗';
    if (lower.contains('suv')) return '🚙';
    if (lower.contains('intercity')) return '🛣️';
    return '🚖';
  }
}

// Tutorial tip row widget used in the first-visit tutorial overlay
class _TutorialTip extends StatelessWidget {
  final String icon;
  final String title;
  final String desc;
  const _TutorialTip(
      {required this.icon, required this.title, required this.desc});

  @override
  Widget build(BuildContext context) {
    return Row(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Container(
          width: 42,
          height: 42,
          decoration: BoxDecoration(
            color: const Color(0xFFEFF6FF),
            borderRadius: BorderRadius.circular(12),
          ),
          child:
              Center(child: Text(icon, style: const TextStyle(fontSize: 20))),
        ),
        const SizedBox(width: 12),
        Expanded(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(title,
                  style: GoogleFonts.poppins(
                      fontWeight: FontWeight.w500,
                      fontSize: 13,
                      color: JT.textPrimary)),
              const SizedBox(height: 2),
              Text(desc,
                  style: GoogleFonts.poppins(
                      fontSize: 12,
                      color: const Color(0xFF64748B),
                      height: 1.4)),
            ],
          ),
        ),
      ],
    );
  }
}
