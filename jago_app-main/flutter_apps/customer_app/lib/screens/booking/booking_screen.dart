import 'dart:async';
import 'dart:convert';
import 'dart:math';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:google_maps_flutter/google_maps_flutter.dart';
import 'package:http/http.dart' as http;
import 'package:razorpay_flutter/razorpay_flutter.dart';
import 'package:shimmer/shimmer.dart';
import 'package:url_launcher/url_launcher.dart';
import 'package:google_fonts/google_fonts.dart';
import '../../config/api_config.dart';
import '../../config/jago_theme.dart';
import '../../services/auth_service.dart';
import '../../services/trip_service.dart';
import '../../services/vehicle_status_service.dart';
import '../tracking/parcel_tracking_screen.dart';
import '../tracking/tracking_screen.dart';
import 'ride_for_whom_screen.dart';

class BookingScreen extends StatefulWidget {
  final String pickup;
  final String destination;
  final double pickupLat, pickupLng, destLat, destLng;
  final String? vehicleCategoryId;
  final String? vehicleCategoryName;
  final String? category; // 'ride' | 'parcel' | 'pool'
  const BookingScreen({
    super.key,
    required this.pickup,
    required this.destination,
    this.pickupLat = 17.3850, this.pickupLng = 78.4867,
    this.destLat = 0, this.destLng = 0,
    this.vehicleCategoryId,
    this.vehicleCategoryName,
    this.category,
  });
  @override
  State<BookingScreen> createState() => _BookingScreenState();
}

class _BookingScreenState extends State<BookingScreen> with TickerProviderStateMixin {
  GoogleMapController? _mapController;
  bool _mapCreated = false;
  bool _loading = false;
  bool _estimating = true;
  List<Map<String, dynamic>> _allFares = [];
  int _selectedFareIndex = 0;
  List<Map<String, dynamic>> _bookableVehicleCategories = [];
  Map<String, dynamic>? _selectedVehicleSelection;
  String _paymentMethod = 'cash';
  double _walletBalance = 0;
  final TextEditingController _promoCtrl = TextEditingController();
  final VehicleStatusService _vehicleStatusService = VehicleStatusService();
  String? _appliedPromo;
  double _promoDiscount = 0;
  bool _promoLoading = false;
  String? _promoError;
  Timer? _debounce;

  late Razorpay _razorpay;

  // Pool ride seat selection
  int _seatsBooked = 1;
  double _poolFarePerSeat = 0;
  bool _poolFareLoading = false;

  bool get _isLocalPoolVehicle {
    final vt = _normalizeVehicleType(
      _fare?['vehicleType']?.toString() ??
      _fare?['type']?.toString() ??
      _fareVehicleName(_fare ?? const <String, dynamic>{}),
    );
    return vt == 'local_pool' || vt == 'carpool';
  }

  bool _bookForSomeone = false;
  final _passengerNameCtrl = TextEditingController();
  final _passengerPhoneCtrl = TextEditingController();
  final _receiverNameCtrl = TextEditingController();
  final _receiverPhoneCtrl = TextEditingController();
  final _noteCtrl = TextEditingController();
  Set<Polyline> _polylines = {};
  double _routedDistanceKm = 0.0;

  static const Color _jagoPrimary = JT.primary;
  static const Color _jagoSecondary = JT.secondary;

  static const Color _blue = Color(0xFF6366F1); // Vibrant Indigo
  static const Color _green = JT.success;

  LatLng get _pickupLatLng => LatLng(widget.pickupLat, widget.pickupLng);
  LatLng get _destLatLng => widget.destLat != 0 && widget.destLng != 0
    ? LatLng(widget.destLat, widget.destLng)
    : LatLng(widget.pickupLat + 0.02, widget.pickupLng + 0.02);

  Map<String, dynamic>? get _fare => _allFares.isNotEmpty ? _allFares[_selectedFareIndex] : null;

  String get _vehicleName => _fare?['vehicleCategoryName']?.toString() ?? _fare?['name']?.toString() ?? widget.vehicleCategoryName ?? 'Bike';

  String _fareVehicleName(Map<String, dynamic> fare) {
    return fare['vehicleCategoryName']?.toString() ??
        fare['vehicleName']?.toString() ??
        fare['name']?.toString() ??
        'Bike';
  }

  String _normalizeVehicleLookupKey(String? raw) {
    return (raw ?? '')
        .trim()
        .toLowerCase()
        .replaceAll('&', 'and')
        .replaceAll(RegExp(r'[^a-z0-9]+'), '_')
        .replaceAll(RegExp(r'^_+|_+$'), '');
  }

  String? _normalizeVehicleType(String? raw) {
    final key = (raw ?? '').trim().toLowerCase();
    if (key.isEmpty) return null;
    if (key.contains('bike parcel')) return 'bike_parcel';
    if (key.contains('parcel auto')) return 'auto_parcel';
    if (key.contains('mini truck') || key.contains('tata ace')) return 'mini_truck';
    if (key.contains('pickup')) return 'pickup_truck';
    if (key.contains('tempo')) return 'tempo_407';
    if (key.contains('outstation pool') || key.contains('outstation')) return 'outstation_pool';
    if (key.contains('local pool') || key.contains('city pool')) return 'local_pool';
    if (key.contains('pool') || key.contains('carpool')) return 'local_pool';
    if (key.contains('bike')) return 'bike';
    if (key.contains('auto')) return 'auto';
    if (key.contains('cab') ||
        key.contains('car') ||
        key.contains('sedan') ||
        key.contains('suv') ||
        key.contains('premium')) {
      return 'car';
    }
    return null;
  }

  bool _isParcelVehicleType(String? value) {
    final normalized = _normalizeVehicleType(value) ?? _normalizeVehicleLookupKey(value);
    return normalized.contains('parcel') ||
        normalized.contains('truck') ||
        normalized.contains('pickup') ||
        normalized.contains('tempo');
  }

  bool _isBookableCategoryActive(Map<String, dynamic> category) {
    final raw = category['isActive'] ?? category['is_active'];
    if (raw is bool) return raw;
    return raw?.toString().toLowerCase() != 'false';
  }

  int _categoryMatchScore(
    Map<String, dynamic> category,
    String? requestedType,
    String requestedName,
  ) {
    if (!_isBookableCategoryActive(category)) return -1;

    final categoryType = category['type']?.toString().toLowerCase() ?? '';
    final name = category['name']?.toString() ?? '';
    final nameKey = _normalizeVehicleLookupKey(name);
    final isParcel = _isParcelVehicleType(requestedType) || requestedName.contains('parcel');

    if (isParcel) {
      if (categoryType != 'parcel' && categoryType != 'cargo') return -1;
    } else if (categoryType == 'parcel' || categoryType == 'cargo') {
      return -1;
    }

    final requestedKey = _normalizeVehicleLookupKey(requestedName);
    var score = 0;

    if (requestedType == 'local_pool' && (nameKey.contains('local_pool') || nameKey.contains('city_pool') || nameKey.contains('pool'))) score += 120;
    if (requestedType == 'outstation_pool' && (nameKey.contains('outstation') || nameKey.contains('outstation_pool'))) score += 120;
    if (requestedType == 'bike' && nameKey.contains('bike')) score += 120;
    if (requestedType == 'auto' && nameKey.contains('auto')) score += 120;
    if (requestedType == 'car') {
      if (requestedKey.contains('premium') && nameKey.contains('premium')) score += 180;
      if (requestedKey.contains('sedan') && nameKey.contains('sedan')) score += 170;
      if (requestedKey.contains('suv') && nameKey.contains('suv')) score += 170;
      if (nameKey.contains('cab') || nameKey.contains('car') || nameKey.contains('sedan') || nameKey.contains('suv')) {
        score += 110;
      }
    }
    if (requestedType == 'bike_parcel' && nameKey.contains('bike') && nameKey.contains('parcel')) score += 180;
    if (requestedType == 'auto_parcel' && nameKey.contains('auto') && nameKey.contains('parcel')) score += 180;
    if (requestedType == 'mini_truck' && (nameKey.contains('mini') || nameKey.contains('tata'))) score += 180;
    if (requestedType == 'pickup_truck' && nameKey.contains('pickup')) score += 180;

    if (requestedKey.isNotEmpty) {
      if (requestedKey == nameKey) score += 240;
      if (requestedKey.contains('bike') && nameKey.contains('bike')) score += 90;
      if (requestedKey.contains('auto') && nameKey.contains('auto')) score += 90;
      if (requestedKey.contains('cab') && (nameKey.contains('cab') || nameKey.contains('car'))) score += 80;
      if (requestedKey.contains('premium') && nameKey.contains('premium')) score += 90;
      if (requestedKey.contains('parcel') && nameKey.contains('parcel')) score += 100;
      if (requestedKey.contains('truck') && nameKey.contains('truck')) score += 100;
      if (requestedKey.contains('pickup') && nameKey.contains('pickup')) score += 100;
    }

    return score;
  }

  Map<String, dynamic>? _resolveVehicleCategoryForFare(Map<String, dynamic> fare) {
    if (_bookableVehicleCategories.isEmpty) return null;
    final requestedName = _fareVehicleName(fare);
    final requestedType = _normalizeVehicleType(
      fare['vehicleType']?.toString() ??
          fare['type']?.toString() ??
          requestedName,
    );

    Map<String, dynamic>? best;
    var bestScore = -1;
    for (final category in _bookableVehicleCategories) {
      final score = _categoryMatchScore(category, requestedType, requestedName);
      if (score > bestScore) {
        bestScore = score;
        best = category;
      }
    }
    return bestScore >= 0 ? best : null;
  }

  List<Map<String, dynamic>> _hydrateFaresWithCatalog(List<Map<String, dynamic>> fares) {
    return fares.map((fare) {
      final existingId = fare['vehicleCategoryId']?.toString() ?? fare['id']?.toString() ?? '';
      if (existingId.isNotEmpty) return fare;
      final resolved = _resolveVehicleCategoryForFare(fare);
      if (resolved == null) return fare;
      return {
        ...fare,
        'vehicleCategoryId': resolved['id']?.toString(),
        'vehicleCategoryName': fare['vehicleCategoryName'] ?? resolved['name'],
      };
    }).toList();
  }

  Map<String, dynamic>? _buildSelectionFromFare(Map<String, dynamic>? fare) {
    if (fare == null) return null;
    final resolvedCategory = _resolveVehicleCategoryForFare(fare);
    final categoryId = fare['vehicleCategoryId']?.toString() ??
        fare['id']?.toString() ??
        resolvedCategory?['id']?.toString();
    final vehicleName = _fareVehicleName({
      ...fare,
      if (resolvedCategory != null && fare['vehicleCategoryName'] == null) 'vehicleCategoryName': resolvedCategory['name'],
    });
    final vehicleType = _normalizeVehicleType(
      fare['vehicleType']?.toString() ??
          fare['type']?.toString() ??
          vehicleName,
    );
    return {
      'vehicleCategoryId': categoryId,
      'vehicleType': vehicleType,
      'vehicleName': vehicleName,
      'resolved': categoryId != null && categoryId.isNotEmpty && vehicleType != null && vehicleType.isNotEmpty,
    };
  }

  void _refreshSelectedVehicleSelection() {
    final selection = _buildSelectionFromFare(_fare);
    if (!mounted) {
      _selectedVehicleSelection = selection;
      return;
    }
    setState(() => _selectedVehicleSelection = selection);
  }

  bool get _hasResolvedVehicleSelection =>
      _selectedVehicleSelection?['resolved'] == true;

  bool get _hasBookingInputs =>
      widget.pickup.trim().isNotEmpty &&
      widget.destination.trim().isNotEmpty &&
      widget.pickupLat != 0 &&
      widget.pickupLng != 0 &&
      widget.destLat != 0 &&
      widget.destLng != 0;

  bool get _canConfirmRide =>
      !_loading &&
      !_estimating &&
      _allFares.isNotEmpty &&
      _hasBookingInputs &&
      _hasResolvedVehicleSelection;

  List<MapEntry<int, Map<String, dynamic>>> _visibleFareEntries(
    Map<String, VehicleStatus> statuses,
  ) {
    return _allFares.asMap().entries.where((entry) {
      return _isFareAvailable(entry.value, statuses);
    }).toList();
  }

  bool _isFareAvailable(
    Map<String, dynamic> fare,
    Map<String, VehicleStatus> statuses,
  ) {
    final backendFlag = fare['isActive'];
    if (backendFlag is bool) return backendFlag;
    if (backendFlag != null) {
      return backendFlag.toString().toLowerCase() == 'true';
    }
    final name = _fareVehicleName(fare);
    return VehicleStatusService.isActive(statuses, name);
  }

  void _syncSelectedFareToVisible(Map<String, VehicleStatus> statuses) {
    if (_allFares.isEmpty) return;
    if (_isFareAvailable(_allFares[_selectedFareIndex], statuses)) return;
    final visible = _visibleFareEntries(statuses);
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted || visible.isEmpty) return;
      setState(() => _selectedFareIndex = visible.first.key);
      _refreshSelectedVehicleSelection();
    });
  }

  static IconData _iconForVehicle(String name) {
    final n = name.toLowerCase();
    if (n.contains('pickup van') || n.contains('pickup')) return Icons.fire_truck_rounded;
    if (n.contains('mini truck') || n.contains('tata ace') || n.contains('mini cargo')) return Icons.local_shipping_rounded;
    if (n.contains('parcel bike') || n.contains('bike parcel') || n.contains('parcel auto')) return Icons.delivery_dining_rounded;
    if (n.contains('parcel')) return Icons.inventory_2_rounded;
    if (n.contains('bike')) return Icons.electric_bike_rounded;
    if (n.contains('auto')) return Icons.electric_rickshaw_rounded;
    if (n.contains('cargo truck')) return Icons.fire_truck_rounded;
    if (n.contains('cargo')) return Icons.local_shipping_rounded;
    if (n.contains('suv')) return Icons.directions_car_filled_rounded;
    if (n.contains('car')) return Icons.directions_car_filled_rounded;
    return Icons.directions_car_filled_rounded;
  }

  static String _emojiForVehicle(String name) {
    final n = name.toLowerCase();
    // Parcel vehicles — MUST show goods/delivery vehicles, NOT passenger
    if (n.contains('pickup van') || n.contains('pickup')) return '🚛';     // Heavy pickup van
    if (n.contains('mini truck') || n.contains('tata ace')) return '🚐';   // Mini cargo truck
    if (n.contains('parcel bike') || n.contains('bike parcel')) return '🛵'; // Delivery bike
    if (n.contains('parcel auto')) return '🛻';  // ✅ GOODS AUTO — pickup/cargo truck feel (not passenger auto 🛺, not bus)
    if (n.contains('parcel')) return '🚐';       // Generic parcel vehicle
    // Ride vehicles
    if (n.contains('bike')) return '🏍️';
    if (n.contains('auto')) return '🛺';         // Passenger auto only for ride
    if (n.contains('cargo truck')) return '🚛';
    if (n.contains('cargo')) return '🚐';
    if (n.contains('suv')) return '🚙';
    if (n.contains('car')) return '🚗';
    return '🚗';
  }

  // Rule 3: Parcel Auto subtitle must clearly say GOODS ONLY
  static String _subtitleForVehicle(String name) {
    final n = name.toLowerCase();
    if (n.contains('parcel auto')) return 'Goods Carrier Auto · CARGO ONLY';
    if (n.contains('parcel bike')) return 'Delivery bike · Up to 10 kg';
    if (n.contains('mini truck') || n.contains('tata ace')) return 'Mini cargo truck · Up to 500 kg';
    if (n.contains('pickup van') || n.contains('pickup')) return 'Large pickup van · Up to 2000 kg';
    if (n.contains('parcel')) return 'Parcel delivery';
    if (n.contains('outstation pool') || (n.contains('outstation') && n.contains('pool'))) return 'Intercity shared ride · Save more';
    if (n.contains('local pool') || n.contains('city pool')) return 'Share your ride · 2-3 seats';
    if (n.contains('pool') || n.contains('carpool')) return 'Shared ride · Cost effective';
    if (n.contains('bike')) return '1 passenger · Fastest';
    if (n.contains('auto')) return 'Up to 3 passengers';
    if (n.contains('suv')) return 'Up to 6 passengers · AC';
    if (n.contains('car')) return 'Up to 4 passengers · AC';
    return '';
  }

  // Rule 4: Returns true if vehicle should be HIDDEN
  static bool _shouldHideVehicle(String name) {
    final n = name.toLowerCase();

    // Whitelist all valid ride categories
    if (n.contains('bike')) return false;
    if (n.contains('auto')) return false;
    if (n.contains('cab')) return false;
    if (n.contains('premium')) return false;
    if (n.contains('sedan')) return false;
    if (n.contains('car')) return false;
    if (n.contains('pool')) return false;      // local pool, city pool, outstation pool
    if (n.contains('carpool')) return false;
    if (n.contains('outstation')) return false;

    // Hide cargo/parcel vehicles from ride list
    return true;
  }

  static Color _accentForVehicle(String name) {
    return const Color(0xFF6366F1); // Unified Premium Indigo
  }

  // ── Vehicle image URLs (real vehicle images, network with emoji fallback) ──
  // Matches the premium Cloudinary assets used in home_screen.dart
  static const Map<String, String> _vehicleImageUrls = {
    'bike': 'https://res.cloudinary.com/kits/image/upload/q_auto/f_auto/v1775123974/bike_logo_g7idrq.png',
    'auto': 'https://res.cloudinary.com/kits/image/upload/q_auto/f_auto/v1775125550/ChatGPT_Image_Apr_2_2026_03_55_30_PM_ywb7fj.png',
    'cab': 'https://res.cloudinary.com/dg5ct7fys/image/upload/f_auto,q_auto/ChatGPT_Image_Apr_17_2026_11_27_28_AM_w0rcnh',
    'premium': 'https://res.cloudinary.com/dg5ct7fys/image/upload/f_auto,q_auto/ChatGPT_Image_Apr_17_2026_11_31_05_AM_kavp5e',
    'parcel_bike': 'https://res.cloudinary.com/dg5ct7fys/image/upload/f_auto,q_auto/ChatGPT_Image_Apr_17_2026_11_49_26_AM_gjbrxs',
    'parcel_auto': 'https://res.cloudinary.com/kits/image/upload/q_auto/f_auto/v1775367404/be5b86c2-7a8a-4dbd-ad33-e8da2b627d5e_vurdrg.png',
    'mini_truck':  'https://res.cloudinary.com/dg5ct7fys/image/upload/f_auto,q_auto/ChatGPT_Image_Apr_17_2026_11_51_59_AM_jzd119',
    'pickup_van':  'https://res.cloudinary.com/dg5ct7fys/image/upload/f_auto,q_auto/ChatGPT_Image_Apr_17_2026_11_54_02_AM_hicx7s',
    'local_pool':       'https://res.cloudinary.com/dg5ct7fys/image/upload/f_auto,q_auto/ChatGPT_Image_Apr_17_2026_11_27_28_AM_w0rcnh',
    'outstation_pool':  'https://res.cloudinary.com/dg5ct7fys/image/upload/f_auto,q_auto/ChatGPT_Image_Apr_17_2026_11_31_05_AM_kavp5e',
  };

  static String? _vehicleImageKey(String name) {
    final n = name.toLowerCase();
    if (n.contains('premium')) return 'premium';
    if (n.contains('pickup van') || n.contains('pickup')) return 'pickup_van';
    if (n.contains('mini truck') || n.contains('tata ace')) return 'mini_truck';
    if (n.contains('parcel bike') || n.contains('bike parcel')) return 'parcel_bike';
    if (n.contains('parcel auto')) return 'parcel_auto';
    if (n.contains('parcel')) return 'parcel_bike';
    if (n.contains('outstation pool') || (n.contains('outstation') && n.contains('pool'))) return 'outstation_pool';
    if (n.contains('local pool') || n.contains('city pool') || n.contains('pool') || n.contains('carpool')) return 'local_pool';
    if (n.contains('bike')) return 'bike';
    if (n.contains('auto')) return 'auto';
    if (n.contains('cab') || n.contains('car') || n.contains('suv')) return 'cab';
    return null;
  }

  Widget _buildVehicleImage(String name, {BoxFit fit = BoxFit.contain, double? width, double? height, Color? tint}) {
    final imgKey = _vehicleImageKey(name);
    final imgUrl = imgKey != null ? _vehicleImageUrls[imgKey] : null;
    final fallback = Center(
      child: Text(
        _emojiForVehicle(name),
        style: TextStyle(fontSize: ((height ?? width ?? 72) * 0.42).clamp(24, 52).toDouble()),
      ),
    );
    if (imgUrl == null) return fallback;
    return Image.network(
      imgUrl,
      width: width,
      height: height,
      fit: fit,
      color: tint,
      colorBlendMode: tint != null ? BlendMode.modulate : null,
      loadingBuilder: (context, child, progress) => progress == null ? child : fallback,
      errorBuilder: (_, __, ___) => fallback,
    );
  }

  /// Renders vehicle artwork — real network image with icon fallback.
  Widget _buildVehicleArtwork(String name, Color accent, bool isSelected, {double size = 96}) {
    final imageKey = _vehicleImageKey(name);
    final imageUrl = imageKey != null ? _vehicleImageUrls[imageKey] : null;
    final icon = _iconForVehicle(name);
    final isParcel = widget.category == 'parcel';

    return AnimatedContainer(
      duration: const Duration(milliseconds: 220),
      width: size, height: size,
      decoration: BoxDecoration(
        color: isSelected ? accent.withValues(alpha: 0.08) : const Color(0xFFF8FAFC),
        borderRadius: const BorderRadius.only(
          topLeft: Radius.circular(14), bottomLeft: Radius.circular(14)),
      ),
      child: Stack(alignment: Alignment.center, children: [
        // Vehicle image (real) with icon fallback
        Padding(
          padding: const EdgeInsets.fromLTRB(8, 8, 8, 18),
          child: imageUrl != null
            ? _buildVehicleImage(name, fit: BoxFit.contain, height: size * 0.62)
            : Icon(
                icon, size: size * 0.44,
                color: accent.withValues(alpha: isSelected ? 0.85 : 0.60),
              ),
        ),
        // DELIVERY / RIDE badge at bottom
        Positioned(
          bottom: 5,
          child: Container(
            padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 2),
            decoration: BoxDecoration(
              color: isSelected ? accent : accent.withValues(alpha: 0.65),
              borderRadius: BorderRadius.circular(6),
            ),
            child: Text(
              isParcel ? 'DELIVERY' : 'RIDE',
              style: const TextStyle(color: Colors.white, fontSize: 7,
                fontWeight: FontWeight.w500, letterSpacing: 0.5),
            ),
          ),
        ),
      ]),
    );
  }

  Widget _buildVehicleHero() {
    if (_allFares.isEmpty) return const SizedBox.shrink();
    final fare = _allFares[_selectedFareIndex];
    final name = fare['vehicleCategoryName']?.toString() ?? fare['name']?.toString() ?? 'Bike';
    final emoji = _emojiForVehicle(name);
    final accent = _accentForVehicle(name);
    final fareVal = (fare['estimatedFare'] ?? 0).toDouble();
    final rawMin = (fare['fareMin'] ?? (fareVal * 0.95)).toDouble();
    final rawMax = (fare['fareMax'] ?? (fareVal * 1.05)).toDouble();
    final displayMin = (rawMin - _promoDiscount).clamp(0.0, double.infinity);
    final displayMax = (rawMax - _promoDiscount).clamp(0.0, double.infinity);
    return AnimatedSwitcher(
      duration: const Duration(milliseconds: 320),
      transitionBuilder: (child, anim) => SlideTransition(
        position: Tween<Offset>(begin: const Offset(0.3, 0), end: Offset.zero).animate(
          CurvedAnimation(parent: anim, curve: Curves.easeOutCubic)),
        child: FadeTransition(opacity: anim, child: child),
      ),
      child: Container(
        key: ValueKey('hero_$name'),
        margin: const EdgeInsets.only(bottom: 12),
        padding: const EdgeInsets.symmetric(horizontal: 20, vertical: 14),
        decoration: BoxDecoration(
          gradient: LinearGradient(
            colors: [accent, accent.withValues(alpha: 0.75)],
            begin: Alignment.centerLeft,
            end: Alignment.centerRight,
          ),
          borderRadius: BorderRadius.circular(20),
          boxShadow: [
            BoxShadow(color: accent.withValues(alpha: 0.35), blurRadius: 18, offset: const Offset(0, 6)),
          ],
        ),
        child: Row(children: [
          Expanded(child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Container(
              padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
              decoration: BoxDecoration(
                color: Colors.white.withValues(alpha: 0.2),
                borderRadius: BorderRadius.circular(8)),
              child: Text('SELECTED', style: const TextStyle(
                color: Colors.white, fontSize: 9, fontWeight: FontWeight.w500, letterSpacing: 1.5)),
            ),
            const SizedBox(height: 8),
            Text(name, style: const TextStyle(
              color: Colors.white, fontSize: 22, fontWeight: FontWeight.w500, letterSpacing: -0.5)),
            const SizedBox(height: 4),
            Text('₹${displayMin.floor()} – ₹${displayMax.ceil()}',
              style: const TextStyle(color: Colors.white, fontSize: 18, fontWeight: FontWeight.w400)),
            Text('estimated fare', style: TextStyle(color: Colors.white.withValues(alpha: 0.75), fontSize: 11)),
          ])),
          // Real vehicle image — emoji fallback if network fails
          Builder(builder: (_) {
            return SizedBox(
              width: 100, height: 80,
              child: _buildVehicleImage(
                name,
                fit: BoxFit.contain,
                width: 100,
                height: 80,
                tint: Colors.white.withValues(alpha: 0.92),
              ),
            );
          }),
        ]),
      ),
    );
  }

  /// Parse "~5 min" / "5 min" / "5-8 min" → arrival minutes number
  static int _etaMins(String timeStr) {
    final match = RegExp(r'(\d+)').firstMatch(timeStr);
    return match != null ? int.tryParse(match.group(1) ?? '5') ?? 5 : 5;
  }

  /// "Drop 6:14 pm" style string from eta
  static String _dropTimeStr(String timeStr) {
    final mins = _etaMins(timeStr);
    final dropTime = DateTime.now().add(Duration(minutes: mins + 10));
    final h = dropTime.hour > 12 ? dropTime.hour - 12 : (dropTime.hour == 0 ? 12 : dropTime.hour);
    final m = dropTime.minute.toString().padLeft(2, '0');
    final ampm = dropTime.hour >= 12 ? 'pm' : 'am';
    return '$h:$m $ampm';
  }

  static String _capacityForVehicle(String name) {
    final n = name.toLowerCase();
    if (n.contains('pickup van') || n.contains('pickup')) return 'Up to 2000 kg';
    if (n.contains('mini truck') || n.contains('tata ace')) return 'Up to 500 kg';
    if (n.contains('parcel bike') || n.contains('bike parcel')) return 'Up to 10 kg';
    if (n.contains('parcel auto')) return 'Up to 50 kg';
    if (n.contains('parcel')) return 'Package delivery';
    if (n.contains('outstation pool')) return 'Shared · intercity';
    if (n.contains('local pool') || n.contains('city pool') || n.contains('pool')) return 'Shared · 2-3 seats';
    if (n.contains('suv')) return '6 seats';
    if (n.contains('car')) return '4 seats';
    if (n.contains('auto')) return '3 seats';
    if (n.contains('bike')) return '1 rider';
    if (n.contains('cargo truck')) return 'Up to 1000 kg';
    if (n.contains('cargo')) return 'Up to 500 kg';
    return '';
  }

  double get _distanceKm {
    if (_routedDistanceKm > 0) return _routedDistanceKm;
    if (widget.destLat == 0 && widget.destLng == 0) return 3.0;
    // Haversine formula for accurate distance calculation
    const double earthRadius = 6371.0;
    final double lat1 = widget.pickupLat * pi / 180;
    final double lat2 = widget.destLat * pi / 180;
    final double dlat = (widget.destLat - widget.pickupLat) * pi / 180;
    final double dlng = (widget.destLng - widget.pickupLng) * pi / 180;
    final double a = sin(dlat / 2) * sin(dlat / 2) +
        cos(lat1) * cos(lat2) * sin(dlng / 2) * sin(dlng / 2);
    final double c = 2 * atan2(sqrt(a), sqrt(1 - a));
    // Road distance is typically 1.3x aerial distance
    return (earthRadius * c * 1.3).clamp(0.5, 200.0);
  }

  String _shortLocation(String value) {
    final v = value.trim();
    if (v.isEmpty) return v;
    return v.split(',').first.trim();
  }

  double get _finalFare {
    final f = (_fare?['estimatedFare'] ?? 0).toDouble();
    return (f - _promoDiscount).clamp(0, double.infinity);
  }

  @override
  void initState() {
    super.initState();
    _razorpay = Razorpay();
    _razorpay.on(Razorpay.EVENT_PAYMENT_SUCCESS, _handleRazorpaySuccess);
    _razorpay.on(Razorpay.EVENT_PAYMENT_ERROR, _handleRazorpayError);
    _razorpay.on(Razorpay.EVENT_EXTERNAL_WALLET, _handleExternalWallet);
    _loadBookableVehicleCategories();
    _estimateFare();
    _fetchWallet();
    _fetchRoutePolyline();
  }

  Future<void> _loadBookableVehicleCategories() async {
    try {
      final headers = await AuthService.getHeaders();
      final res = await http
          .get(Uri.parse(ApiConfig.customerHomeData), headers: headers)
          .timeout(const Duration(seconds: 10));
      if (res.statusCode != 200 || !mounted) return;
      final data = jsonDecode(res.body) as Map<String, dynamic>;
      final categories =
          (data['vehicleCategories'] as List<dynamic>? ?? const [])
              .whereType<Map<String, dynamic>>()
              .toList();
      setState(() {
        _bookableVehicleCategories = categories;
        _allFares = _hydrateFaresWithCatalog(_allFares);
      });
      _refreshSelectedVehicleSelection();
    } catch (_) {}
  }

  @override
  void dispose() {
    _debounce?.cancel();
    _promoCtrl.dispose();
    _razorpay.clear();
    _passengerNameCtrl.dispose();
    _passengerPhoneCtrl.dispose();
    _receiverNameCtrl.dispose();
    _receiverPhoneCtrl.dispose();
    _noteCtrl.dispose();
    super.dispose();
  }

  Future<void> _fetchWallet() async {
    try {
      final headers = await AuthService.getHeaders();
      final res = await http.get(Uri.parse(ApiConfig.wallet),
        headers: headers);
      if (res.statusCode == 200) {
        final data = jsonDecode(res.body);
        if (mounted) setState(() => _walletBalance = (data['balance'] ?? 0).toDouble());
      }
    } catch (_) {}
  }

  void _onCouponChanged(String value) {
    // Clear stale error/discount on code change
    if (_promoError != null) setState(() => _promoError = null);
    _debounce?.cancel();
    // Only auto-apply when user has typed a plausible code (≥4 chars)
    if (value.trim().length >= 4) {
      _debounce = Timer(const Duration(milliseconds: 600), () {
        if (_promoCtrl.text.trim().isNotEmpty) _applyPromo();
      });
    }
  }

  Future<void> _applyPromo() async {
    final code = _promoCtrl.text.trim().toUpperCase();
    if (code.isEmpty) return;
    setState(() { _promoLoading = true; _promoError = null; });
    try {
      final headers = await AuthService.getHeaders();
      final res = await http.post(Uri.parse(ApiConfig.applyCoupon),
        headers: headers,
        body: jsonEncode({'code': code, 'fareAmount': (_fare?['estimatedFare'] ?? 0).toDouble()}));
      if (res.statusCode == 200) {
        try {
          final data = jsonDecode(res.body);
          setState(() {
            _appliedPromo = code;
            _promoDiscount = double.tryParse(data['discount']?.toString() ?? '0') ?? 0;
            _promoLoading = false;
          });
        } catch (_) {
          setState(() { _promoError = 'Invalid response from server'; _promoLoading = false; });
        }
      } else {
        try {
          final data = jsonDecode(res.body);
          setState(() { _promoError = data['message'] ?? 'Invalid code'; _promoLoading = false; });
        } catch (_) {
          setState(() { _promoError = 'Invalid coupon code'; _promoLoading = false; });
        }
      }
    } catch (_) {
      setState(() { _promoError = 'Network error'; _promoLoading = false; });
    }
  }

  Future<void> _estimateFare() async {
    setState(() => _estimating = true);
    try {
      final headers = await AuthService.getHeaders();
      final body = <String, dynamic>{
        'pickupLat': widget.pickupLat, 'pickupLng': widget.pickupLng,
        'destLat': widget.destLat, 'destLng': widget.destLng,
        'distanceKm': _distanceKm,
      };
      if (widget.vehicleCategoryId != null) body['vehicleCategoryId'] = widget.vehicleCategoryId;
      if (widget.category != null) body['category'] = widget.category;
      final res = await http.post(Uri.parse(ApiConfig.estimateFare),
        headers: headers,
        body: jsonEncode(body));
      if (res.statusCode == 200) {
        final data = jsonDecode(res.body);
        final rawFares = data['fares'];
        final fares = rawFares is List ? rawFares.whereType<Map<String, dynamic>>().toList() : null;
        if (fares != null && fares.isNotEmpty) {
          setState(() {
            // Rule 2: Strict service separation — filter by category, hide inactive
            var filtered = fares.toList();
            final cat = widget.category ?? 'ride';
            if (cat == 'parcel') {
              filtered = filtered.where((f) {
                final vname = (f['vehicleCategoryName'] ?? f['name'] ?? '').toString().toLowerCase();
                final vtype = (f['type'] ?? f['vehicleType'] ?? '').toString().toLowerCase();
                return vtype == 'parcel' || vname.contains('parcel') ||
                    vname.contains('truck') || vname.contains('van') ||
                    vname.contains('tata') || vname.contains('mini');
              }).toList();
            } else {
              filtered = filtered.where((f) {
                final vname = (f['vehicleCategoryName'] ?? f['name'] ?? '').toString().toLowerCase();
                final vtype = (f['type'] ?? f['vehicleType'] ?? '').toString().toLowerCase();
                // Exclude parcel/cargo vehicles from ride
                if (vtype == 'parcel' || vname.contains('parcel') || vname.contains('truck') || vname.contains('cargo')) return false;
                // Rule 4: Hide inactive services
                if (_shouldHideVehicle(vname)) return false;
                return true;
              }).toList();
            }
            _allFares = _hydrateFaresWithCatalog(filtered);
            
            // Ensure we have at least the core categories (Bike, Auto, Cab)
            if (widget.category != 'parcel') {
              final fallbacks = _buildFallbackFares();
              for (var fb in fallbacks) {
                final fbName = fb['vehicleCategoryName'].toString();
                // Add fallback if no similar category exists in server result
                if (!_allFares.any((f) {
                  final name = (f['vehicleCategoryName'] ?? f['name'] ?? '').toString().toLowerCase();
                  return name.contains(fbName.split(' ').first.toLowerCase());
                })) {
                  _allFares.add(_hydrateFaresWithCatalog([fb]).first);
                }
              }
            }
            
            // Final safety check: if still empty (shouldn't happen with fallbacks), use all fallbacks
            if (_allFares.isEmpty) _allFares = _hydrateFaresWithCatalog(_buildFallbackFares());
            if (widget.vehicleCategoryId != null || widget.vehicleCategoryName != null) {
              final targetName = (widget.vehicleCategoryName ?? '').toLowerCase();
              final idx = _allFares.indexWhere((f) {
                final fName = (f['vehicleCategoryName'] ?? f['name'] ?? '').toString().toLowerCase();
                final fId = f['vehicleCategoryId']?.toString() ?? f['id']?.toString();
                return fId == widget.vehicleCategoryId || 
                       (targetName.isNotEmpty && fName.contains(targetName));
              });
              if (idx >= 0) _selectedFareIndex = idx;
            }
          });
          _refreshSelectedVehicleSelection();
        } else {
          // Server returned 200 but body wasn't as expected — use fallbacks
          if (mounted) {
            setState(() => _allFares = _hydrateFaresWithCatalog(_buildFallbackFares()));
            _refreshSelectedVehicleSelection();
          }
        }
      } else {
        // Server returned error status — use fallbacks
        if (mounted) {
          setState(() => _allFares = _hydrateFaresWithCatalog(_buildFallbackFares()));
          _refreshSelectedVehicleSelection();
        }
      }
    } catch (_) {
      // Network error — show client-side estimates only on connectivity failure
      if (mounted) {
        setState(() => _allFares = _hydrateFaresWithCatalog(_buildFallbackFares()));
        _refreshSelectedVehicleSelection();
      }
    }
    if (mounted) setState(() => _estimating = false);
  }

  /// Builds client-side fare estimates (Bike/Auto/Car) when the server returns
  /// no fares. Formula: Total = Base + (Distance × Per-KM Rate) + 5% GST.
  List<Map<String, dynamic>> _buildFallbackFares() {
    final dist = _distanceKm;
    final requestKey = _normalizeVehicleLookupKey(widget.vehicleCategoryName);
    final hasPoolCatalog = _bookableVehicleCategories.any((category) {
      final key = _normalizeVehicleLookupKey(category['name']?.toString());
      return key.contains('pool') || key.contains('carpool') || key.contains('outstation');
    });
    final includePoolOptions =
        requestKey.contains('pool') || requestKey.contains('carpool') || hasPoolCatalog;
    Map<String, dynamic> make(
        String name, double base, double perKm, double minFareVal, int eta) {
      final raw = (base + dist * perKm).clamp(minFareVal, double.infinity);
      final gst = double.parse((raw * 0.05).toStringAsFixed(2));
      final grandTotal = double.parse((raw + gst).toStringAsFixed(2));
      return {
        'vehicleCategoryId': null,
        'vehicleCategoryName': name,
        'vehicleName': name,
        'vehicleType': _normalizeVehicleType(name),
        'baseFare': base,
        'farePerKm': perKm,
        'billableKm': dist,
        'distanceFare': double.parse((dist * perKm).toStringAsFixed(2)),
        'timeFare': 0.0,
        'subtotal': double.parse(raw.toStringAsFixed(2)),
        'gst': gst,
        'estimatedFare': grandTotal,
        'fareMin': (grandTotal * 0.95).floor(),
        'fareMax': (grandTotal * 1.05).ceil(),
        'minimumFare': minFareVal,
        'cancellationFee': 10.0,
        'waitingChargePerMin': 0.0,
        'isNightCharge': false,
        'nightMultiplier': 1.0,
        'helperCharge': 0.0,
        'estimatedTime': '$eta min',
      };
    }
    // Parcel-specific vehicles — never mix with ride vehicles
    if (widget.category == 'parcel') {
      return [
        make('Parcel Bike',  20,  8,  25, (dist * 4).ceil()),
        make('Parcel Auto',  30, 10,  35, (dist * 4).ceil()),
        make('Mini Truck',  100, 25, 120, (dist * 5).ceil()),
        make('Pickup Van',  150, 35, 180, (dist * 5).ceil()),
      ];
    }
    // Ride vehicles (default) — includes pool options
    return [
      make('Bike',           25, 10, 28, (dist * 3).ceil()),
      make('Auto',           35, 13, 40, (dist * 3.5).ceil()),
      make('Cab',            50, 16, 60, (dist * 4).ceil()),
      make('Premium Cab',    70, 20, 80, (dist * 4).ceil()),
      if (includePoolOptions) make('Local Pool',     18,  8, 22, (dist * 2.5).ceil()),
      if (includePoolOptions) make('Outstation Pool', 30, 12, 40, (dist * 3).ceil()),
    ];
  }

  Future<void> _confirmBooking({String? razorpayPaymentId}) async {
    if (!_validateBookingBeforeConfirm()) return;
    setState(() => _loading = true);
    try {
      final headers = await AuthService.getHeaders();
      final selection = _selectedVehicleSelection ?? _buildSelectionFromFare(_fare);

      // Determine if this is a local pool booking
      final selectedVehicleType = selection?['vehicleType']?.toString() ??
          _normalizeVehicleType(
            _fare?['vehicleType']?.toString() ??
                _fare?['type']?.toString() ??
                _fareVehicleName(_fare ?? const <String, dynamic>{}),
          );
      final isLocalPool = selectedVehicleType == 'local_pool' || selectedVehicleType == 'carpool';

      if (isLocalPool) {
        // Route to dedicated local pool endpoint
        final vcId = selection?['vehicleCategoryId']?.toString() ??
            _fare?['vehicleCategoryId']?.toString() ??
            _fare?['id']?.toString() ??
            widget.vehicleCategoryId;
        final poolBody = <String, dynamic>{
          'pickupLat': widget.pickupLat, 'pickupLng': widget.pickupLng,
          'dropLat': widget.destLat, 'dropLng': widget.destLng,
          'pickupAddress': widget.pickup,
          'dropAddress': widget.destination,
          'seatsBooked': _seatsBooked,
          'paymentMethod': _paymentMethod,
          if (vcId != null && vcId.isNotEmpty) 'vehicleCategoryId': vcId,
        };
        debugPrint('[LOCAL_POOL_BOOK] payload=${jsonEncode(poolBody)}');
        final res = await http.post(
          Uri.parse('${ApiConfig.baseUrl}/api/app/customer/local-pool/book'),
          headers: headers,
          body: jsonEncode(poolBody),
        );
        if (res.statusCode == 200) {
          final data = jsonDecode(res.body);
          if (!mounted) return;
          _showSnack(
            'Pool ride booked! $_seatsBooked seat(s) · ₹${data['totalFare']?.toStringAsFixed(0) ?? ''} · ${data['message'] ?? 'Matching driver...'}',
            error: false,
          );
          setState(() => _loading = false);
          Navigator.pop(context);
        } else {
          if (!mounted) return;
          final err = jsonDecode(res.body);
          _showSnack(err['message']?.toString() ?? 'Pool booking failed', error: true);
          setState(() => _loading = false);
        }
        return;
      }

      final body = <String, dynamic>{
        'pickupAddress': widget.pickup,
        'destinationAddress': widget.destination,
        'pickupShortName': _shortLocation(widget.pickup),
        'destinationShortName': _shortLocation(widget.destination),
        'pickupLat': widget.pickupLat, 'pickupLng': widget.pickupLng,
        'destinationLat': widget.destLat, 'destinationLng': widget.destLng,
        'estimatedFare': _finalFare,
        'estimatedDistance': _distanceKm,
        'paymentMethod': _paymentMethod,
        if (_promoDiscount > 0) 'promoDiscount': _promoDiscount,
        if (_appliedPromo != null) 'couponCode': _appliedPromo,
        if (razorpayPaymentId != null) 'razorpayPaymentId': razorpayPaymentId,
        'ride_for': _bookForSomeone ? 'other' : 'self',
        if (_bookForSomeone) 'isForSomeoneElse': true,
        if (_bookForSomeone && _passengerNameCtrl.text.trim().isNotEmpty) ...{
          'passengerName': _passengerNameCtrl.text.trim(),
          'passenger_name': _passengerNameCtrl.text.trim(),
        },
        if (_bookForSomeone && _passengerPhoneCtrl.text.trim().isNotEmpty) ...{
          'passengerPhone': _passengerPhoneCtrl.text.trim(),
          'passenger_mobile': _passengerPhoneCtrl.text.trim(),
        },
        if (_bookForSomeone && _receiverNameCtrl.text.trim().isNotEmpty)
          'receiverName': _receiverNameCtrl.text.trim(),
        if (_bookForSomeone && _receiverPhoneCtrl.text.trim().isNotEmpty)
          'receiverPhone': _receiverPhoneCtrl.text.trim(),
        if (_bookForSomeone && _noteCtrl.text.trim().isNotEmpty)
          'note': _noteCtrl.text.trim(),
      };
      final vcId = selection?['vehicleCategoryId']?.toString() ??
          _fare?['vehicleCategoryId']?.toString() ??
          _fare?['id']?.toString() ??
          widget.vehicleCategoryId;
      if (vcId != null && vcId.isNotEmpty) body['vehicleCategoryId'] = vcId;
      if (selectedVehicleType != null) body['vehicleType'] = selectedVehicleType;
      final selectedVehicleName =
          selection?['vehicleName']?.toString() ?? _fareVehicleName(_fare ?? const <String, dynamic>{});
      if (selectedVehicleName.isNotEmpty) {
        body['vehicleCategoryName'] = selectedVehicleName;
        body['vehicleName'] = selectedVehicleName;
      }
      debugPrint('[BOOK_RIDE] payload=${jsonEncode(body)}');
      final res = await http.post(Uri.parse(ApiConfig.bookRide),
        headers: headers,
        body: jsonEncode(body));
      if (res.statusCode == 200) {
        final data = jsonDecode(res.body);
        final tripId = data['trip']?['id']?.toString() ?? '';
        if (!mounted) return;
        if (tripId.isEmpty) {
          _showSnack('Booking confirmed but could not track trip. Please check My Trips.', error: false);
          setState(() => _loading = false);
          Navigator.pop(context);
          return;
        }
        Navigator.pushReplacement(context, MaterialPageRoute(
          builder: (_) => TrackingScreen(tripId: tripId)));
      } else {
        if (!mounted) return;
        try {
          final err = jsonDecode(res.body);
          if (err['tripId'] != null || err['orderId'] != null) {
            await _ensureNoActiveBookingBeforeContinue();
          }
          _showSnack(err['message'] ?? 'Booking failed', error: true);
        } catch (_) {
          _showSnack('Booking failed. Please try again.', error: true);
        }
      }
    } catch (_) {
      if (!mounted) return;
      _showSnack('Network error. Try again.', error: true);
    }
    if (mounted) setState(() => _loading = false);
  }

  /// Offers Google Maps navigation to pickup location after booking is confirmed.
  /// Shows a premium bottom sheet with "Navigate" and "Skip" options.
  Future<void> _offerNavigateToPickup() async {
    if (!mounted) return;
    final pickupLat = widget.pickupLat;
    final pickupLng = widget.pickupLng;
    final pickupAddr = widget.pickup;

    await showModalBottomSheet(
      context: context,
      backgroundColor: Colors.transparent,
      isDismissible: true,
      builder: (_) => Container(
        margin: const EdgeInsets.all(16),
        padding: const EdgeInsets.all(24),
        decoration: BoxDecoration(
          color: Colors.white,
          borderRadius: BorderRadius.circular(24),
          boxShadow: [BoxShadow(color: Colors.black.withValues(alpha: 0.3), blurRadius: 30)],
        ),
        child: Column(mainAxisSize: MainAxisSize.min, children: [
          Container(
            width: 56, height: 56,
            decoration: BoxDecoration(
              gradient: const LinearGradient(colors: [Color(0xFF16A34A), Color(0xFF15803D)]),
              shape: BoxShape.circle,
              boxShadow: [BoxShadow(color: const Color(0xFF16A34A).withValues(alpha: 0.35), blurRadius: 16)],
            ),
            child: const Icon(Icons.check_rounded, color: Colors.white, size: 28),
          ),
          const SizedBox(height: 16),
          Text('Ride Booked! 🎉',
            style: TextStyle(fontSize: 20, fontWeight: FontWeight.w500,
              color: JT.textPrimary)),
          const SizedBox(height: 8),
          Text('Navigate to pickup location?',
            style: TextStyle(fontSize: 14, color: Colors.grey[600])),
          const SizedBox(height: 6),
          Text(pickupAddr,
            style: const TextStyle(fontSize: 13, color: JT.primary, fontWeight: FontWeight.w400),
            maxLines: 2, overflow: TextOverflow.ellipsis, textAlign: TextAlign.center),
          const SizedBox(height: 20),
          Row(children: [
            Expanded(
              child: GestureDetector(
                onTap: () => Navigator.pop(context),
                child: Container(
                  height: 48,
                  decoration: BoxDecoration(
                    color: Colors.grey.shade100,
                    borderRadius: BorderRadius.circular(14),
                    border: Border.all(color: Colors.grey.shade200),
                  ),
                  child: Center(child: Text('Skip',
                    style: TextStyle(fontWeight: FontWeight.w500,
                      color: Colors.grey[700]))),
                ),
              ),
            ),
            const SizedBox(width: 12),
            Expanded(
              flex: 2,
              child: GestureDetector(
                onTap: () async {
                  Navigator.pop(context);
                  // Try Google Maps first, fallback to geo: URI
                  final gmUrl = 'google.navigation:q=$pickupLat,$pickupLng&mode=d';
                  final geoUrl = 'geo:$pickupLat,$pickupLng?q=$pickupLat,$pickupLng($pickupAddr)';
                  final mapsUrl = 'https://maps.google.com/?daddr=$pickupLat,$pickupLng&directionsmode=driving';
                  if (await canLaunchUrl(Uri.parse(gmUrl))) {
                    await launchUrl(Uri.parse(gmUrl));
                  } else if (await canLaunchUrl(Uri.parse(geoUrl))) {
                    await launchUrl(Uri.parse(geoUrl));
                  } else {
                    await launchUrl(Uri.parse(mapsUrl), mode: LaunchMode.externalApplication);
                  }
                },
                child: Container(
                  height: 48,
                  decoration: BoxDecoration(
                    gradient: const LinearGradient(colors: [JT.primary, Color(0xFF1244A2)]),
                    borderRadius: BorderRadius.circular(14),
                    boxShadow: [BoxShadow(color: JT.primary.withValues(alpha: 0.35), blurRadius: 12)],
                  ),
                  child: const Center(child: Row(mainAxisAlignment: MainAxisAlignment.center, children: [
                    Icon(Icons.navigation_rounded, color: Colors.white, size: 18),
                    SizedBox(width: 8),
                    Text('Navigate Now', style: TextStyle(color: Colors.white, fontWeight: FontWeight.w500, fontSize: 14)),
                  ])),
                ),
              ),
            ),
          ]),
          const SizedBox(height: 8),
        ]),
      ),
    );
  }

  bool _validateBookingBeforeConfirm() {
    if (widget.pickup.trim().isEmpty || widget.pickupLat == 0 || widget.pickupLng == 0) {
      _showSnack('Pickup location is missing. Please choose a valid pickup point.', error: true);
      return false;
    }
    if (widget.destination.trim().isEmpty || widget.destLat == 0 || widget.destLng == 0) {
      _showSnack('Drop location is missing. Please choose a valid destination.', error: true);
      return false;
    }
    if (!_hasResolvedVehicleSelection) {
      _showSnack('Please select a live vehicle option before confirming your ride.', error: true);
      return false;
    }
    return true;
  }

  Future<bool> _ensureNoActiveBookingBeforeContinue() async {
    final active = await TripService.getActiveBooking();
    final booking = active['booking'];
    final bookingType = active['bookingType']?.toString();
    if (booking is! Map<String, dynamic> || bookingType == null || bookingType.isEmpty) {
      return true;
    }

    final canCancel = booking['canCancel'] == true;
    final bookingId = booking['id']?.toString() ?? '';
    final title = bookingType == 'parcel' ? 'Active parcel found' : 'Active ride found';
    final subtitle = bookingType == 'parcel'
        ? (booking['pickupAddress']?.toString() ?? 'Parcel booking in progress')
        : (booking['destinationAddress']?.toString() ?? 'Ride booking in progress');

    final action = await showModalBottomSheet<String>(
      context: context,
      backgroundColor: Colors.white,
      shape: const RoundedRectangleBorder(
        borderRadius: BorderRadius.vertical(top: Radius.circular(24)),
      ),
      builder: (_) => Padding(
        padding: const EdgeInsets.all(24),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(title, style: const TextStyle(fontSize: 18, fontWeight: FontWeight.w700)),
            const SizedBox(height: 8),
            Text(
              subtitle,
              style: const TextStyle(fontSize: 14, color: Color(0xFF64748B)),
            ),
            const SizedBox(height: 18),
            SizedBox(
              width: double.infinity,
              child: ElevatedButton(
                onPressed: () => Navigator.pop(context, 'track'),
                style: ElevatedButton.styleFrom(
                  backgroundColor: JT.primary,
                  shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(14)),
                ),
                child: const Text('Track Current Booking', style: TextStyle(color: Colors.white)),
              ),
            ),
            if (canCancel) ...[
              const SizedBox(height: 10),
              SizedBox(
                width: double.infinity,
                child: OutlinedButton(
                  onPressed: () => Navigator.pop(context, 'cancel'),
                  style: OutlinedButton.styleFrom(
                    shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(14)),
                  ),
                  child: const Text('Cancel Current Booking And Continue'),
                ),
              ),
            ],
          ],
        ),
      ),
    );

    if (!mounted) return false;
    if (action == 'track' && bookingId.isNotEmpty) {
      if (bookingType == 'parcel') {
        await Navigator.push(
          context,
          MaterialPageRoute(builder: (_) => ParcelTrackingScreen(orderId: bookingId)),
        );
      } else {
        await Navigator.push(
          context,
          MaterialPageRoute(builder: (_) => TrackingScreen(tripId: bookingId)),
        );
      }
      return false;
    }

    if (action == 'cancel' && bookingId.isNotEmpty && canCancel) {
      final result = bookingType == 'parcel'
          ? await TripService.cancelParcelOrder(
              bookingId,
              reason: 'Customer cancelled to continue with a new ride booking',
            )
          : await TripService.cancelTrip(
              bookingId,
              'Customer cancelled to continue with a new ride booking',
            );
      if (result['success'] == true) {
        _showSnack('Previous booking cancelled. Continue with your new ride.', error: false);
        return true;
      }
      _showSnack(
        result['message']?.toString() ?? result['error']?.toString() ?? 'Could not cancel current booking.',
        error: true,
      );
    }

    return false;
  }

  Future<void> _goToRideForWhomScreen() async {
    if (!_validateBookingBeforeConfirm()) return;
    try {
      final statuses = await _vehicleStatusService.watchVehicleStatuses().first;
      final currentFare = (_selectedFareIndex >= 0 && _selectedFareIndex < _allFares.length)
          ? _allFares[_selectedFareIndex]
          : <String, dynamic>{'vehicleName': _vehicleName, 'isActive': true};
      if (!_isFareAvailable(currentFare, statuses)) {
        _showSnack('$_vehicleName is temporarily unavailable by admin.', error: true);
        return;
      }
    } catch (_) {}
    final canContinue = await _ensureNoActiveBookingBeforeContinue();
    if (!canContinue) return;
    final result = await Navigator.push(context, MaterialPageRoute(
      builder: (_) => RideForWhomScreen(vehicleName: _vehicleName),
    ));
    if (result != null && result is Map) {
      setState(() {
        _bookForSomeone = result['isForSomeone'] == true;
        if (_bookForSomeone) {
          _passengerNameCtrl.text = result['name'] ?? '';
          _passengerPhoneCtrl.text = result['phone'] ?? '';
          _noteCtrl.text = result['note'] ?? '';
        } else {
          _passengerNameCtrl.clear();
          _passengerPhoneCtrl.clear();
          _noteCtrl.clear();
        }
      });
      _handleOnConfirm();
    }
  }

  Future<void> _handleOnConfirm() async {
    if (_paymentMethod == 'upi') {
      await _startRazorpayRidePayment();
    } else {
      if (_paymentMethod == 'wallet') {
        final fare = _finalFare;
        if (_walletBalance < fare) {
          _showSnack('Insufficient wallet balance. Please recharge.', error: true);
          return;
        }
      }
      await _confirmBooking();
    }
  }

  Future<void> _startRazorpayRidePayment() async {
    setState(() => _loading = true);
    try {
      final headers = await AuthService.getHeaders();
      final fare = _finalFare;
      final res = await http.post(Uri.parse(ApiConfig.rideCreateOrder),
        headers: headers,
        body: jsonEncode({'amount': fare}));
      if (res.statusCode != 200) {
        setState(() => _loading = false);
        try {
          final err = jsonDecode(res.body);
          _showSnack(err['message'] ?? 'Payment setup failed', error: true);
        } catch (_) {
          _showSnack('Payment setup failed. Try again.', error: true);
        }
        return;
      }
      final data = jsonDecode(res.body);
      final order = data['order'];
      final keyId = data['keyId'];
      if (order == null || keyId == null) {
        setState(() => _loading = false);
        _showSnack('Payment setup failed. Try again.', error: true);
        return;
      }
      final profileData = await AuthService.getProfile();
      final options = {
        'key': keyId,
        'amount': order['amount'],
        'currency': 'INR',
        'name': 'Jago Rides',
        'description': 'Ride to ${_shortLocation(widget.destination)}',
        'order_id': order['id'],
        'prefill': {
          'name': profileData?['fullName'] ?? '',
          'contact': profileData?['phone'] ?? '',
        },
        'theme': {'color': '#1E6DE5'},
      };
      _razorpay.open(options);
    } catch (_) {
      setState(() => _loading = false);
      _showSnack('Payment failed. Try again.', error: true);
    }
  }

  void _handleRazorpaySuccess(PaymentSuccessResponse response) async {
    if (!mounted) return;
    setState(() => _loading = true);
    try {
      final headers = await AuthService.getHeaders();
      final verifyRes = await http.post(Uri.parse(ApiConfig.rideVerifyPayment),
        headers: headers,
        body: jsonEncode({
          'razorpayOrderId': response.orderId,
          'razorpayPaymentId': response.paymentId,
          'razorpaySignature': response.signature,
          'amount': _finalFare,
        }));
      if (verifyRes.statusCode == 200) {
        await _confirmBooking(razorpayPaymentId: response.paymentId);
      } else {
        if (!mounted) return;
        setState(() => _loading = false);
        _showSnack('Payment verification failed. Contact support.', error: true);
      }
    } catch (_) {
      if (!mounted) return;
      setState(() => _loading = false);
      _showSnack('Payment verification failed.', error: true);
    }
  }

  void _handleRazorpayError(PaymentFailureResponse response) {
    setState(() => _loading = false);
    _showSnack(response.message ?? 'Payment cancelled', error: true);
  }

  void _handleExternalWallet(ExternalWalletResponse response) {
    setState(() => _loading = false);
  }

  void _showSnack(String msg, {bool error = false}) {
    ScaffoldMessenger.of(context).showSnackBar(SnackBar(
      content: Text(msg, style: const TextStyle(fontWeight: FontWeight.w400, color: Colors.white)),
      backgroundColor: error ? const Color(0xFFDC2626) : _green,
      behavior: SnackBarBehavior.floating,
      margin: const EdgeInsets.all(16),
      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12)),
    ));
  }

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

  Future<void> _fetchRoutePolyline() async {
    bool success = false;
    List<LatLng> points = [];
    double fetchedDistMeters = 0.0;

    // Attempt 1: backend route proxy using one controlled server-side Maps key
    try {
      final headers = await AuthService.getHeaders();
      final res = await http.post(
        Uri.parse(ApiConfig.routeMultiWaypoint),
        headers: {...headers, 'Content-Type': 'application/json'},
        body: jsonEncode({
          'origin': {'lat': widget.pickupLat, 'lng': widget.pickupLng},
          'destination': {'lat': widget.destLat, 'lng': widget.destLng},
          'waypoints': [],
          'optimize': false,
        }),
      ).timeout(const Duration(seconds: 4));
      if (res.statusCode == 200) {
        final data = jsonDecode(res.body) as Map<String, dynamic>;
        final overviewPolyline = data['overviewPolyline']?.toString() ?? '';
        if (overviewPolyline.isNotEmpty) {
          points = _decodePolyline(overviewPolyline);
          final totalDistanceKm =
              (data['totalDistanceKm'] as num?)?.toDouble() ??
              (data['distanceKm'] as num?)?.toDouble() ??
              0.0;
          fetchedDistMeters = totalDistanceKm * 1000;
          success = points.isNotEmpty;
        }
      }
    } catch (_) {}

    // Attempt 2: simpler backend route proxy fallback
    if (!success) {
      try {
        final headers = await AuthService.getHeaders();
        final uri = Uri.parse(ApiConfig.route).replace(queryParameters: {
          'originLat': widget.pickupLat.toString(),
          'originLng': widget.pickupLng.toString(),
          'destLat': widget.destLat.toString(),
          'destLng': widget.destLng.toString(),
        });
        final res = await http.get(uri, headers: headers).timeout(const Duration(seconds: 4));
        if (res.statusCode == 200) {
          final data = jsonDecode(res.body) as Map<String, dynamic>;
          final encoded = data['polyline']?.toString() ?? '';
          if (encoded.isNotEmpty) {
            points = _decodePolyline(encoded);
            fetchedDistMeters = ((data['distanceKm'] as num?)?.toDouble() ?? 0.0) * 1000;
            success = points.isNotEmpty;
          }
        }
      } catch (_) {}
    }

    // Attempt 3: straight-line fallback so the map still renders a route
    if (!success) {
      points = [_pickupLatLng, _destLatLng];
      success = true;
    }

    if (!mounted) return;

    if (success) {
      if (fetchedDistMeters > 0) {
        _routedDistanceKm = fetchedDistMeters / 1000.0;
        // Recalculate true road distance fares
        _estimateFare();
      }

      setState(() {
        _polylines = {
          Polyline( // Production quality curvy road line constraint
            polylineId: const PolylineId('route'),
            points: points,
            color: _jagoPrimary,
            width: 5,
            jointType: JointType.round,
            startCap: Cap.roundCap,
            endCap: Cap.roundCap,
            geodesic: true,
          )
        };
      });
      _fitMapToRoute(routePoints: points);
    } else {
      setState(() {
        _polylines = {
          Polyline(
            polylineId: const PolylineId('route_fallback'),
            points: [_pickupLatLng, _destLatLng],
            color: _blue, width: 4,
            patterns: [PatternItem.dash(20), PatternItem.gap(10)]
          )
        };
      });
      _fitMapToRoute();
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
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
                    onTap: () => Navigator.pop(context),
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
              child: Stack(
                children: [
                  GoogleMap(
                    initialCameraPosition: CameraPosition(target: _pickupLatLng, zoom: 14),
                    onMapCreated: (c) {
                      _mapController = c;
                      if (mounted) setState(() => _mapCreated = true);
                      debugPrint(
                        '[MAP] Booking map created pickup=${_pickupLatLng.latitude},${_pickupLatLng.longitude} dest=${_destLatLng.latitude},${_destLatLng.longitude}',
                      );
                      _fitMapToRoute();
                    },
                    markers: {
                      Marker(markerId: const MarkerId('p'), position: _pickupLatLng, icon: BitmapDescriptor.defaultMarkerWithHue(BitmapDescriptor.hueAzure)),
                      Marker(markerId: const MarkerId('d'), position: _destLatLng, icon: BitmapDescriptor.defaultMarkerWithHue(BitmapDescriptor.hueRed)),
                    },
                    polylines: _polylines,
                    zoomControlsEnabled: false,
                    myLocationButtonEnabled: false,
                    mapToolbarEnabled: false,
                    compassEnabled: false,
                    buildingsEnabled: true,
                  ),
                  if (!_mapCreated)
                    const Positioned.fill(
                      child: IgnorePointer(
                        child: Center(
                          child: CircularProgressIndicator(color: JT.primary),
                        ),
                      ),
                    ),
                    
                    // Floating Address Card
                    Positioned(
                      top: 20, left: 20, right: 20,
                      child: Container(
                        decoration: BoxDecoration(
                          color: Colors.white,
                          borderRadius: BorderRadius.circular(20),
                          boxShadow: [BoxShadow(color: Colors.black.withValues(alpha: 0.1), blurRadius: 20, offset: const Offset(0, 8))],
                        ),
                        child: Column(
                          children: [
                            _addressRow(Icons.circle, const Color(0xFF6366F1), widget.pickup),
                            const Divider(height: 1, indent: 56, endIndent: 20),
                            _addressRow(Icons.location_on, const Color(0xFFEF4444), widget.destination),
                          ],
                        ),
                      ),
                    ),

                    // Draggable Sheet
                  DraggableScrollableSheet(
                    initialChildSize: 0.45,
                    minChildSize: 0.35,
                    maxChildSize: 0.9,
                    builder: (context, scrollController) {
                      return Container(
                          decoration: const BoxDecoration(
                            color: Colors.white,
                            borderRadius: BorderRadius.vertical(top: Radius.circular(32)),
                            boxShadow: [BoxShadow(color: Colors.black12, blurRadius: 20, spreadRadius: 2)],
                          ),
                          child: StreamBuilder<Map<String, VehicleStatus>>(
                            stream: _vehicleStatusService.watchVehicleStatuses(),
                            builder: (context, snapshot) {
                              final statuses = snapshot.data ?? {};
                              final visibleFares = _visibleFareEntries(statuses);
                              final canBook = _canConfirmRide && visibleFares.isNotEmpty;

                              return Container(
                                decoration: BoxDecoration(
                                  color: Colors.white,
                                  borderRadius: const BorderRadius.only(
                                    topLeft: Radius.circular(32),
                                    topRight: Radius.circular(32),
                                  ),
                                  boxShadow: [
                                    BoxShadow(
                                      color: Colors.black.withOpacity(0.1),
                                      blurRadius: 20,
                                      offset: const Offset(0, -5),
                                    ),
                                  ],
                                ),
                                child: Column(
                                  children: [
                                    Container(
                                      width: 48, height: 5,
                                      margin: const EdgeInsets.symmetric(vertical: 14),
                                      decoration: BoxDecoration(
                                        color: Colors.grey.shade300,
                                        borderRadius: BorderRadius.circular(10),
                                      ),
                                    ),
                                    Expanded(
                                      child: ListView(
                                        controller: scrollController,
                                        padding: const EdgeInsets.fromLTRB(16, 0, 16, 16),
                                        children: [
                                          _buildVehicleSelector(statuses),
                                          if (_isLocalPoolVehicle) ...[
                                            const SizedBox(height: 12),
                                            _buildPoolSeatSelector(),
                                          ],
                                          if (!_hasResolvedVehicleSelection && !_estimating) ...[
                                            const SizedBox(height: 12),
                                            Container(
                                              padding: const EdgeInsets.all(12),
                                              decoration: BoxDecoration(
                                                color: const Color(0xFFFEF2F2),
                                                borderRadius: BorderRadius.circular(14),
                                                border: Border.all(color: const Color(0xFFFCA5A5)),
                                              ),
                                              child: const Row(
                                                children: [
                                                  Icon(Icons.info_outline, color: Color(0xFFDC2626), size: 18),
                                                  SizedBox(width: 10),
                                                  Expanded(
                                                    child: Text(
                                                      'Live vehicle selection not resolved yet. Please wait or reselect a vehicle before confirming.',
                                                      style: TextStyle(
                                                        fontSize: 12,
                                                        color: Color(0xFF991B1B),
                                                        fontWeight: FontWeight.w600,
                                                      ),
                                                    ),
                                                  ),
                                                ],
                                              ),
                                            ),
                                          ],
                                          const SizedBox(height: 24),
                                          _buildPaymentSection(),
                                          const SizedBox(height: 24),
                                          Container(
                                            decoration: BoxDecoration(
                                              borderRadius: BorderRadius.circular(16),
                                              boxShadow: [
                                                BoxShadow(
                                                  color: const Color(0xFF2D8CFF).withOpacity(0.3),
                                                  blurRadius: 15,
                                                  offset: const Offset(0, 8),
                                                ),
                                              ],
                                            ),
                                            child: JT.gradientButton(
                                              label: visibleFares.isEmpty ? 'No vehicles available' : 'Confirm Ride',
                                              loading: _loading,
                                              onTap: canBook ? () => _goToRideForWhomScreen() : () {},
                                              radius: 16,
                                              height: 60,
                                            ),
                                          ),
                                          const SizedBox(height: 20),
                                        ],
                                      ),
                                    ),
                                  ],
                                ),
                              );
                            },
                          ),
                        );
                    },
                  ),
                ],
              ),
            ),
          ),
        ],
      ),
      bottomNavigationBar: _buildBottomNav(),
    );
  }


  bool get _isParcel {
    final n = _vehicleName.toLowerCase();
    return n.contains('parcel') || n.contains('cargo') || n.contains('delivery');
  }

  Widget _buildPaymentSection() {
    return Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
      const Text('Payment Method',
        style: TextStyle(fontSize: 13, fontWeight: FontWeight.w500, color: Color(0xFF374151), letterSpacing: 0.2)),
      const SizedBox(height: 10),
      Row(children: [
        Expanded(child: _payBtn('cash', Icons.payments_rounded, 'Cash')),
        const SizedBox(width: 8),
        Expanded(child: _payBtn('wallet', Icons.account_balance_wallet_rounded, 'Wallet')),
        const SizedBox(width: 8),
        Expanded(child: _payBtn('upi', Icons.qr_code_scanner_rounded, 'UPI')),
      ]),
      if (_paymentMethod == 'wallet') ...[
        const SizedBox(height: 8),
        Container(
          padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
          decoration: BoxDecoration(
            color: _walletBalance >= _finalFare
              ? const Color(0xFFF0FDF4)
              : const Color(0xFFFEF2F2),
            borderRadius: BorderRadius.circular(10),
            border: Border.all(
              color: _walletBalance >= _finalFare
                ? const Color(0xFF86EFAC)
                : const Color(0xFFFCA5A5)),
          ),
          child: Row(children: [
            Icon(
              _walletBalance >= _finalFare ? Icons.check_circle_rounded : Icons.warning_rounded,
              color: _walletBalance >= _finalFare ? _green : const Color(0xFFDC2626),
              size: 16,
            ),
            const SizedBox(width: 8),
            Expanded(child: Text(
              _walletBalance >= _finalFare
                ? 'Wallet balance ₹${_walletBalance.toStringAsFixed(0)} • Sufficient'
                : 'Insufficient balance (₹${_walletBalance.toStringAsFixed(0)}). Please recharge.',
              style: TextStyle(
                fontSize: 12, fontWeight: FontWeight.w400,
                color: _walletBalance >= _finalFare ? _green : const Color(0xFFDC2626),
              ),
            )),
          ]),
        ),
      ],
      if (_paymentMethod == 'upi') ...[
        const SizedBox(height: 8),
        Container(
          padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
          decoration: BoxDecoration(
            color: const Color(0xFFF0F7FF),
            borderRadius: BorderRadius.circular(10),
            border: Border.all(color: _blue.withValues(alpha: 0.2)),
          ),
          child: Row(children: [
            const Icon(Icons.lock_rounded, color: _blue, size: 15),
            const SizedBox(width: 8),
            const Expanded(child: Text(
              'Secure payment via Razorpay — UPI, Cards, Netbanking accepted',
              style: TextStyle(fontSize: 12, color: JT.primary, fontWeight: FontWeight.w500),
            )),
          ]),
        ),
      ],
    ]);
  }

  Widget _payBtn(String method, IconData icon, String label) {
    final selected = _paymentMethod == method;
    const blue = Color(0xFF2D8CFF);
    const lavender = Color(0xFF8B5CF6);
    
    return GestureDetector(
      onTap: () {
        HapticFeedback.selectionClick();
        setState(() => _paymentMethod = method);
      },
      child: AnimatedContainer(
        duration: const Duration(milliseconds: 250),
        padding: const EdgeInsets.symmetric(vertical: 12, horizontal: 10),
        decoration: BoxDecoration(
          color: selected ? lavender.withOpacity(0.08) : Colors.white,
          borderRadius: BorderRadius.circular(16),
          border: Border.all(
            color: selected ? lavender : Colors.grey.shade200,
            width: selected ? 2 : 1.5,
          ),
          boxShadow: selected ? [
            BoxShadow(color: lavender.withOpacity(0.15), blurRadius: 10, offset: const Offset(0, 4))
          ] : [],
        ),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Icon(icon, size: 22, color: selected ? lavender : Colors.grey.shade500),
            const SizedBox(height: 6),
            Text(
              label,
              style: GoogleFonts.outfit(
                fontSize: 13,
                fontWeight: selected ? FontWeight.w700 : FontWeight.w500,
                color: selected ? lavender : Colors.grey.shade600,
              ),
            ),
          ],
        ),
      ),
    );
  }

  Widget _addressRow(IconData icon, Color color, String text, [Color? textColor]) {
    final tColor = textColor ?? JT.textPrimary;
    final isPickup = icon == Icons.circle;
    return Padding(
      padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 11),
      child: Row(crossAxisAlignment: CrossAxisAlignment.center, children: [
        Container(
          width: 28, height: 28,
          decoration: BoxDecoration(
            color: color.withValues(alpha: 0.1),
            shape: BoxShape.circle,
            border: Border.all(color: color.withValues(alpha: 0.3), width: 1.5),
          ),
          child: Icon(icon, color: color, size: isPickup ? 10 : 16),
        ),
        const SizedBox(width: 12),
        Expanded(child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Text(isPickup ? 'PICKUP' : 'DROP',
            style: TextStyle(fontSize: 9, fontWeight: FontWeight.w500, color: color.withValues(alpha: 0.8), letterSpacing: 0.8)),
          const SizedBox(height: 2),
          Text(text,
            style: TextStyle(fontSize: 13, fontWeight: FontWeight.w500, color: tColor),
            maxLines: 1, overflow: TextOverflow.ellipsis),
        ])),
      ]),
    );
  }

  bool _isNightTime() {
    final hour = DateTime.now().hour;
    return hour >= 22 || hour < 6;
  }

  Widget _buildNightChargeIndicator() {
    if (!_isNightTime()) return const SizedBox.shrink();
    return Padding(
      padding: const EdgeInsets.only(bottom: 12),
      child: Container(
        padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 10),
        decoration: BoxDecoration(
          color: JT.surfaceAlt, borderRadius: BorderRadius.circular(12),
          border: Border.all(color: JT.border)),
        child: Row(children: [
          const Text('🌙', style: TextStyle(fontSize: 16)),
          const SizedBox(width: 8),
          Expanded(child: Text('Night charges apply (10PM - 6AM)',
            style: TextStyle(color: JT.textPrimary, fontSize: 13, fontWeight: FontWeight.w400))),
          Container(
            padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
            decoration: BoxDecoration(color: JT.primary.withValues(alpha: 0.1), borderRadius: BorderRadius.circular(8)),
            child: Text('1.25x', style: TextStyle(color: JT.primary, fontSize: 12, fontWeight: FontWeight.w400)),
          ),
        ]),
      ),
    );
  }

  String? _getVehicleTag(int index) {
    if (_allFares.length < 2) return null;
    int fastestIdx = 0, saverIdx = 0, premiumIdx = 0;
    for (int j = 0; j < _allFares.length; j++) {
      final f = _allFares[j];
      final fare = (f['estimatedFare'] ?? 0).toDouble();
      final bestFare = (_allFares[saverIdx]['estimatedFare'] ?? 0).toDouble();
      final highFare = (_allFares[premiumIdx]['estimatedFare'] ?? 0).toDouble();
      if (fare < bestFare) saverIdx = j;
      if (fare > highFare) premiumIdx = j;
      final timeStr = f['estimatedTime']?.toString() ?? '99 min';
      final timeNum = int.tryParse(timeStr.replaceAll(RegExp(r'[^0-9]'), '')) ?? 99;
      final bestTimeStr = _allFares[fastestIdx]['estimatedTime']?.toString() ?? '99 min';
      final bestTimeNum = int.tryParse(bestTimeStr.replaceAll(RegExp(r'[^0-9]'), '')) ?? 99;
      if (timeNum < bestTimeNum) fastestIdx = j;
    }
    if (index == fastestIdx) return 'FASTEST';
    if (index == saverIdx && index != fastestIdx) return 'SAVER';
    if (index == premiumIdx && index != fastestIdx && _allFares.length >= 3) return 'PREMIUM';
    return null;
  }

  Widget _vehicleTagBadge(String tag) {
    Color color;
    IconData icon;
    switch (tag) {
      case 'FASTEST':
        color = const Color(0xFF7C3AED); // Premium Purple matching image
        icon = Icons.bolt_rounded;
        break;
      case 'SAVER':
        color = const Color(0xFF10B981);
        icon = Icons.savings_rounded;
        break;
      case 'PREMIUM':
        color = const Color(0xFFFFD700);
        icon = Icons.star_rounded;
        break;
      default:
        return const SizedBox.shrink();
    }
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 7, vertical: 3),
      decoration: BoxDecoration(
        color: color.withValues(alpha: 0.12),
        borderRadius: BorderRadius.circular(6),
        border: Border.all(color: color.withValues(alpha: 0.35), width: 1),
      ),
      child: Row(mainAxisSize: MainAxisSize.min, children: [
        Icon(icon, color: color, size: 10),
        const SizedBox(width: 3),
        Text(tag, style: TextStyle(color: color, fontSize: 9, fontWeight: FontWeight.w500, letterSpacing: 0.5)),
      ]),
    );
  }

  void _fitMapToRoute({List<LatLng>? routePoints}) {
    if (_mapController == null) return;
    Future.delayed(const Duration(milliseconds: 300), () {
      double minLat, maxLat, minLng, maxLng;
      
      if (routePoints != null && routePoints.isNotEmpty) {
        minLat = maxLat = routePoints.first.latitude;
        minLng = maxLng = routePoints.first.longitude;
        for (final p in routePoints) {
          if (p.latitude < minLat) minLat = p.latitude;
          if (p.latitude > maxLat) maxLat = p.latitude;
          if (p.longitude < minLng) minLng = p.longitude;
          if (p.longitude > maxLng) maxLng = p.longitude;
        }
      } else {
        final pLat = _pickupLatLng.latitude;
        final pLng = _pickupLatLng.longitude;
        final dLat = widget.destLat != 0 ? widget.destLat : pLat + 0.005;
        final dLng = widget.destLng != 0 ? widget.destLng : pLng + 0.005;
        minLat = min(pLat, dLat);
        maxLat = max(pLat, dLat);
        minLng = min(pLng, dLng);
        maxLng = max(pLng, dLng);
      }

      try {
        _mapController?.animateCamera(CameraUpdate.newLatLngBounds(
          LatLngBounds(
            southwest: LatLng(minLat, minLng),
            northeast: LatLng(maxLat, maxLng),
          ),
          90, // Significant visual padding for the route
        ));
      } catch (_) {}
    });
  }

  Widget _buildVehicleSelector(Map<String, VehicleStatus> statuses) {
    if (_estimating) {
      return Padding(
        padding: const EdgeInsets.symmetric(vertical: 8),
        child: Shimmer.fromColors(
          baseColor: const Color(0xFFE5E7EB),
          highlightColor: const Color(0xFFF3F4F6),
          child: Column(children: List.generate(2, (_) => Padding(
            padding: const EdgeInsets.only(bottom: 12),
            child: Container(height: 80, decoration: BoxDecoration(color: Colors.white, borderRadius: BorderRadius.circular(20))),
          ))),
        ),
      );
    }
    _syncSelectedFareToVisible(statuses);
    final visibleFares = _visibleFareEntries(statuses);
    if (visibleFares.isEmpty && !_estimating) {
      return Container(
        width: double.infinity,
        padding: const EdgeInsets.symmetric(horizontal: 18, vertical: 30),
        decoration: BoxDecoration(
          color: const Color(0xFFF8FAFC),
          borderRadius: BorderRadius.circular(24),
          border: Border.all(color: const Color(0xFFE2E8F0)),
        ),
        child: Column(
          children: [
            const Icon(Icons.no_transfer_rounded, color: Color(0xFF64748B), size: 40),
            const SizedBox(height: 12),
            Text(
              'No vehicles available',
              style: GoogleFonts.outfit(
                color: const Color(0xFF0F172A),
                fontSize: 17,
                fontWeight: FontWeight.w700,
              ),
            ),
            const SizedBox(height: 6),
            const Text(
              'Please check back in a few minutes.',
              textAlign: TextAlign.center,
              style: TextStyle(color: Color(0xFF64748B), fontSize: 13),
            ),
          ],
        ),
      );
    }

    return Column(
      children: visibleFares.map((entry) {
        final i = entry.key;
        final f = entry.value;
        final isActive = f['isActive'] != false;
        final isSelected = i == _selectedFareIndex && isActive;
        final name = f['vehicleCategoryName']?.toString() ?? f['vehicleName']?.toString() ?? f['name']?.toString() ?? 'Bike';
        final fareVal = (f['estimatedFare'] ?? 0).toDouble();
        final time = f['estimatedTime']?.toString() ?? '~5 min';
        final displayFare = isSelected ? (fareVal - _promoDiscount).clamp(0.0, double.infinity) : fareVal;
        
        final etaMins = _etaMins(time);
        final dropTime = _dropTimeStr(time);
        final tag = _getVehicleTag(i);
        final isFastest = tag == 'FASTEST';
        
        final subtitle = isActive ? '$etaMins min • Drop $dropTime' : 'Currently Unavailable';

        // Elite Selection Palette
        final Color selColor = const Color(0xFF8B5CF6); // Jago Lavender
        final Color blueColor = const Color(0xFF2D8CFF); // Jago Blue
        
        return GestureDetector(
          key: ValueKey(i),
          onTap: () {
            if (!isActive) return;
            HapticFeedback.selectionClick();
            setState(() => _selectedFareIndex = i);
            _refreshSelectedVehicleSelection();
          },
          child: AnimatedContainer(
            duration: const Duration(milliseconds: 300),
            margin: const EdgeInsets.only(bottom: 12),
            padding: const EdgeInsets.all(12),
            decoration: BoxDecoration(
              color: isSelected ? selColor.withOpacity(0.06) : Colors.white,
              borderRadius: BorderRadius.circular(20),
              border: Border.all(
                color: isSelected ? selColor.withOpacity(0.3) : Colors.grey.shade100,
                width: isSelected ? 2 : 1,
              ),
              boxShadow: isSelected ? [
                BoxShadow(color: selColor.withOpacity(0.08), blurRadius: 12, offset: const Offset(0, 4))
              ] : [
                BoxShadow(color: Colors.black.withOpacity(0.02), blurRadius: 5, offset: const Offset(0, 2))
              ],
            ),
            child: Opacity(
              opacity: isActive ? 1.0 : 0.6,
              child: Row(
                children: [
                  // Vehicle Illustration
                  Container(
                    width: 70, height: 70,
                    padding: const EdgeInsets.all(4),
                    decoration: BoxDecoration(
                      color: isSelected ? selColor.withOpacity(0.1) : const Color(0xFFF9FAFB),
                      borderRadius: BorderRadius.circular(16),
                    ),
                    child: Builder(builder: (_) {
                      return _buildVehicleImage(name, fit: BoxFit.contain, height: 56);
                    }),
                  ),
                  const SizedBox(width: 16),
                  
                  // Details
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Row(
                          children: [
                            Text(
                              name,
                              style: GoogleFonts.outfit(
                                fontSize: 18, 
                                fontWeight: FontWeight.w700, 
                                color: const Color(0xFF1E293B)
                              ),
                            ),
                            if (isFastest && isActive) ...[
                              const SizedBox(width: 8),
                              Container(
                                padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 2),
                                decoration: BoxDecoration(
                                  color: const Color(0xFFE8F2FF),
                                  borderRadius: BorderRadius.circular(6),
                                ),
                                child: Text('FASTEST', 
                                  style: GoogleFonts.outfit(color: blueColor, fontSize: 9, fontWeight: FontWeight.w800)),
                              ),
                            ],
                          ],
                        ),
                        const SizedBox(height: 4),
                        Text(
                          subtitle,
                          style: GoogleFonts.outfit(
                            color: isSelected ? selColor : const Color(0xFF64748B), 
                            fontSize: 13, 
                            fontWeight: isSelected ? FontWeight.w600 : FontWeight.w400
                          ),
                        ),
                      ],
                    ),
                  ),
                  
                  // Pricing
                  Builder(builder: (_) {
                    final vt = _normalizeVehicleType(
                      f['vehicleType']?.toString() ?? f['type']?.toString() ?? name,
                    );
                    final isPool = vt == 'local_pool' || vt == 'carpool';
                    return Column(
                      crossAxisAlignment: CrossAxisAlignment.end,
                      children: [
                        Text(
                          '₹${displayFare.toStringAsFixed(0)}',
                          style: GoogleFonts.outfit(
                            fontSize: 22,
                            fontWeight: FontWeight.w800,
                            color: const Color(0xFF1E293B),
                          ),
                        ),
                        if (isPool)
                          Text(
                            'per seat',
                            style: GoogleFonts.outfit(fontSize: 11, color: const Color(0xFF7C3AED), fontWeight: FontWeight.w600),
                          ),
                        if (isSelected && _promoDiscount > 0)
                          Text(
                            '₹${fareVal.toInt()}',
                            style: const TextStyle(fontSize: 12, color: Colors.grey, decoration: TextDecoration.lineThrough),
                          ),
                      ],
                    );
                  }),
                ],
              ),
            ),
          ),
        );
      }).toList(),
    );
  }

  Widget _buildPoolSeatSelector() {
    // fareVal = per-seat fare for THIS passenger's pickup→drop distance
    // (server/fallback calculates: perSeatBase + perSeatKmRate × distanceKm)
    final farePerSeat = (_fare?['estimatedFare'] ?? 0).toDouble();
    final totalFare = farePerSeat * _seatsBooked;
    // Commission + GST breakdown (10% commission + 18% GST on commission = ~11.8% total)
    final commissionPct = 10.0;
    final gstOnComm = 1.8; // 18% of 10% = 1.8%
    final commission = totalFare * commissionPct / 100;
    final gst = totalFare * gstOnComm / 100;
    final driverEarns = totalFare - commission - gst;

    const purple = Color(0xFF7C3AED);
    const green = Color(0xFF16A34A);

    return Container(
      margin: const EdgeInsets.only(bottom: 12),
      padding: const EdgeInsets.all(16),
      decoration: BoxDecoration(
        color: purple.withOpacity(0.04),
        borderRadius: BorderRadius.circular(20),
        border: Border.all(color: purple.withOpacity(0.18), width: 1.5),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          // Header
          Row(children: [
            const Icon(Icons.people_rounded, size: 18, color: purple),
            const SizedBox(width: 8),
            Text('Select Seats', style: GoogleFonts.outfit(fontWeight: FontWeight.w700, fontSize: 15, color: const Color(0xFF1E293B))),
            const Spacer(),
            Container(
              padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
              decoration: BoxDecoration(color: purple.withOpacity(0.1), borderRadius: BorderRadius.circular(8)),
              child: Text('Pool Ride', style: GoogleFonts.outfit(color: purple, fontSize: 11, fontWeight: FontWeight.w700)),
            ),
          ]),
          const SizedBox(height: 6),
          // Distance-based fare explanation
          if (farePerSeat > 0)
            Container(
              padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 6),
              decoration: BoxDecoration(
                color: const Color(0xFFF0FDF4),
                borderRadius: BorderRadius.circular(8),
                border: Border.all(color: const Color(0xFFBBF7D0)),
              ),
              child: Row(children: [
                const Icon(Icons.route_rounded, size: 14, color: green),
                const SizedBox(width: 6),
                Expanded(
                  child: Text(
                    'Your fare: ₹${farePerSeat.toStringAsFixed(0)} per seat based on your route (${_distanceKm.toStringAsFixed(1)} km)',
                    style: GoogleFonts.outfit(fontSize: 11, color: green, fontWeight: FontWeight.w600),
                  ),
                ),
              ]),
            ),
          const SizedBox(height: 12),
          // Seat buttons
          Row(
            mainAxisAlignment: MainAxisAlignment.center,
            children: List.generate(4, (idx) {
              final n = idx + 1;
              final sel = _seatsBooked == n;
              return GestureDetector(
                onTap: () { HapticFeedback.selectionClick(); setState(() => _seatsBooked = n); },
                child: AnimatedContainer(
                  duration: const Duration(milliseconds: 200),
                  margin: const EdgeInsets.symmetric(horizontal: 6),
                  width: 60, height: 64,
                  decoration: BoxDecoration(
                    color: sel ? purple : const Color(0xFFF1F5F9),
                    borderRadius: BorderRadius.circular(16),
                    border: Border.all(color: sel ? purple : Colors.grey.shade200, width: sel ? 2 : 1),
                    boxShadow: sel ? [BoxShadow(color: purple.withOpacity(0.25), blurRadius: 8, offset: const Offset(0, 3))] : [],
                  ),
                  child: Column(
                    mainAxisAlignment: MainAxisAlignment.center,
                    children: [
                      Icon(Icons.person_rounded, size: 22, color: sel ? Colors.white : Colors.grey.shade500),
                      const SizedBox(height: 2),
                      Text('$n seat${n > 1 ? 's' : ''}',
                        style: GoogleFonts.outfit(fontSize: 10, fontWeight: FontWeight.w700, color: sel ? Colors.white : Colors.grey.shade600)),
                    ],
                  ),
                ),
              );
            }),
          ),
          const SizedBox(height: 14),
          // Fare calculation breakdown — the core logic display
          if (farePerSeat > 0) ...[
            Container(
              padding: const EdgeInsets.all(12),
              decoration: BoxDecoration(
                color: Colors.white,
                borderRadius: BorderRadius.circular(12),
                border: Border.all(color: purple.withOpacity(0.12)),
              ),
              child: Column(children: [
                // Per-seat × seats = total
                Row(
                  mainAxisAlignment: MainAxisAlignment.spaceBetween,
                  children: [
                    Text('₹${farePerSeat.toStringAsFixed(0)}/seat  ×  $_seatsBooked seat${_seatsBooked > 1 ? 's' : ''}',
                      style: GoogleFonts.outfit(fontSize: 13, color: const Color(0xFF64748B))),
                    Text('₹${totalFare.toStringAsFixed(0)}',
                      style: GoogleFonts.outfit(fontSize: 13, fontWeight: FontWeight.w700, color: const Color(0xFF1E293B))),
                  ],
                ),
                const Divider(height: 16, thickness: 0.5),
                // Commission + GST line
                Row(
                  mainAxisAlignment: MainAxisAlignment.spaceBetween,
                  children: [
                    Text('Jago commission (10%) + GST',
                      style: GoogleFonts.outfit(fontSize: 11, color: const Color(0xFF94A3B8))),
                    Text('−₹${(commission + gst).toStringAsFixed(0)}',
                      style: GoogleFonts.outfit(fontSize: 11, color: const Color(0xFFEF4444))),
                  ],
                ),
                const SizedBox(height: 6),
                // Driver earns
                Row(
                  mainAxisAlignment: MainAxisAlignment.spaceBetween,
                  children: [
                    Text('Driver earns',
                      style: GoogleFonts.outfit(fontSize: 11, color: const Color(0xFF64748B))),
                    Text('₹${driverEarns.toStringAsFixed(0)}',
                      style: GoogleFonts.outfit(fontSize: 11, fontWeight: FontWeight.w600, color: green)),
                  ],
                ),
                const Divider(height: 16, thickness: 0.5),
                // YOU PAY
                Row(
                  mainAxisAlignment: MainAxisAlignment.spaceBetween,
                  children: [
                    Text('You Pay',
                      style: GoogleFonts.outfit(fontSize: 15, fontWeight: FontWeight.w700, color: const Color(0xFF1E293B))),
                    Text('₹${totalFare.toStringAsFixed(0)}',
                      style: GoogleFonts.outfit(fontSize: 20, fontWeight: FontWeight.w800, color: purple)),
                  ],
                ),
              ]),
            ),
            const SizedBox(height: 8),
            Text(
              'Each passenger pays based on their own route distance. Other passengers in your pool may pay differently.',
              style: GoogleFonts.outfit(fontSize: 10, color: const Color(0xFF94A3B8)),
            ),
          ],
        ],
      ),
    );
  }

  Widget _buildFareBreakdown(Map<String, dynamic> fare) {
    const cardBg = Color(0xFFF8FAFF);
    const borderCol = Color(0xFFE8EFFF);
    const textMain = JT.textPrimary;
    final textSub = Colors.grey.shade600;

    final baseFare = (fare['baseFare'] ?? 0).toDouble();
    final distanceFare = (fare['distanceFare'] ?? 0).toDouble();
    final timeFare = (fare['timeFare'] ?? 0).toDouble();
    final helperCharge = (fare['helperCharge'] ?? 0).toDouble();
    final gst = (fare['gst'] ?? 0).toDouble();
    final minFare = (fare['minimumFare'] ?? 0).toDouble();
    final farePerKm = (fare['farePerKm'] ?? 0).toDouble();
    final waitingChargePerMin = (fare['waitingChargePerMin'] ?? 0).toDouble();
    final subtotal = (fare['subtotal'] ?? (baseFare + distanceFare + timeFare)).toDouble();
    final isMinFareApplied = minFare > 0 && subtotal <= minFare + 0.01;
    final isNight = fare['isNightCharge'] == true;

    return Container(
      decoration: BoxDecoration(
        color: cardBg,
        borderRadius: BorderRadius.circular(16),
        border: Border.all(color: borderCol),
      ),
      child: Column(children: [
        // Header
        Container(
          padding: const EdgeInsets.fromLTRB(16, 14, 16, 12),
          decoration: BoxDecoration(
            color: _jagoPrimary.withValues(alpha: 0.06),
            borderRadius: const BorderRadius.only(topLeft: Radius.circular(15), topRight: Radius.circular(15)),
            border: Border(bottom: BorderSide(color: borderCol)),
          ),
          child: Row(children: [
            const Icon(Icons.receipt_long_rounded, size: 16, color: _jagoPrimary),
            const SizedBox(width: 8),
            Text(_isParcel ? 'Delivery Fare Details' : 'Fare Breakdown',
              style: const TextStyle(fontSize: 13, fontWeight: FontWeight.w400, color: _jagoPrimary)),
            const Spacer(),
            if (isMinFareApplied)
              Container(
                padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
                decoration: BoxDecoration(
                  color: JT.primary.withValues(alpha: 0.12),
                  borderRadius: BorderRadius.circular(8),
                  border: Border.all(color: JT.primary.withValues(alpha: 0.3)),
                ),
                child: const Text('Min fare', style: TextStyle(
                  fontSize: 10, color: JT.primary, fontWeight: FontWeight.w400)),
              )
            else if (isNight)
              Container(
                padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
                decoration: BoxDecoration(
                  color: const Color(0xFF8B5CF6).withValues(alpha: 0.12),
                  borderRadius: BorderRadius.circular(8),
                  border: Border.all(color: const Color(0xFF8B5CF6).withValues(alpha: 0.3)),
                ),
                child: const Text('Night fare', style: TextStyle(
                  fontSize: 10, color: Color(0xFF8B5CF6), fontWeight: FontWeight.w400)),
              )
            else
              Text('Incl. GST', style: TextStyle(fontSize: 10, color: Colors.grey[400], fontWeight: FontWeight.w500)),
          ]),
        ),
        Padding(
          padding: const EdgeInsets.all(14),
          child: Column(children: [
            // Base fare row with rate info
            _fareRow('Base Fare (Booking Fee)', '₹${baseFare.toStringAsFixed(0)}', textSub: textSub),
            // Distance fare — always show when farePerKm > 0
            if (farePerKm > 0) ...[
              _fareRow(
                '${_distanceKm.toStringAsFixed(1)} km × ₹${farePerKm.toStringAsFixed(0)}/km',
                '₹${distanceFare.toStringAsFixed(0)}',
                textSub: textSub,
              ),
            ] else if (distanceFare > 0)
              _fareRow('Distance (${_distanceKm.toStringAsFixed(1)} km)',
                '₹${distanceFare.toStringAsFixed(0)}', textSub: textSub),
            if (timeFare > 0)
              _fareRow('Time Charge (per min)', '₹${timeFare.toStringAsFixed(0)}', textSub: textSub),
            if (waitingChargePerMin > 0)
              _fareRow('Waiting Charge (₹${waitingChargePerMin.toStringAsFixed(0)}/min)', '—', textSub: textSub),
            // Parcel-specific: helper charge (Porter style)
            if (_isParcel && helperCharge > 0)
              Container(
                margin: const EdgeInsets.symmetric(vertical: 4),
                padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 6),
                decoration: BoxDecoration(
                  color: const Color(0xFF10B981).withValues(alpha: 0.08),
                  borderRadius: BorderRadius.circular(8),
                  border: Border.all(color: const Color(0xFF10B981).withValues(alpha: 0.2)),
                ),
                child: Row(children: [
                  const Icon(Icons.person_2_rounded, size: 13, color: Color(0xFF10B981)),
                  const SizedBox(width: 6),
                  Expanded(child: Text('Helper Charge (loading/unloading)',
                    style: TextStyle(fontSize: 11, color: textSub))),
                  Text('₹${helperCharge.toStringAsFixed(0)}',
                    style: const TextStyle(fontSize: 12, fontWeight: FontWeight.w500, color: Color(0xFF10B981))),
                ]),
              )
            else if (!_isParcel && helperCharge > 0)
              _fareRow('Helper Charge', '₹${helperCharge.toStringAsFixed(0)}', textSub: textSub),
            // Night multiplier
            if (isNight) ...[
              const SizedBox(height: 2),
              Row(children: [
                const Icon(Icons.nightlight_round, size: 12, color: Color(0xFF8B5CF6)),
                const SizedBox(width: 5),
                Text('Night fare applies (1.0x–1.25x)',
                  style: TextStyle(fontSize: 11, color: textSub, fontStyle: FontStyle.italic)),
              ]),
            ],
            // Minimum fare note
            if (minFare > 0) ...[
              const SizedBox(height: 4),
              Row(children: [
                Icon(Icons.info_outline_rounded, size: 12, color: Colors.grey[400]),
                const SizedBox(width: 5),
                Text('Minimum fare: ₹${minFare.toStringAsFixed(0)}',
                  style: TextStyle(fontSize: 11, color: Colors.grey[400])),
              ]),
            ],
            Divider(height: 18, color: borderCol, thickness: 1),
            _fareRow('GST (5%)', '₹${gst.toStringAsFixed(0)}', textSub: textSub),
            if (_promoDiscount > 0)
              _fareRow('Promo Discount', '-₹${_promoDiscount.toInt()}', positive: true, textSub: textSub),
            const SizedBox(height: 8),
            // Total row — bold, large, orange
            Row(children: [
              Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                Text('Total Fare', style: TextStyle(fontSize: 15, fontWeight: FontWeight.w500, color: textMain)),
                if (minFare > 0 && isMinFareApplied)
                  Text('Min fare applied', style: TextStyle(fontSize: 10, color: Colors.grey[400])),
              ]),
              const Spacer(),
              Column(crossAxisAlignment: CrossAxisAlignment.end, children: [
                Text('₹${_finalFare.toStringAsFixed(0)}',
                  style: const TextStyle(fontSize: 26, fontWeight: FontWeight.w500, color: _jagoPrimary)),
                Text('incl. GST', style: TextStyle(fontSize: 10, color: Colors.grey[400])),
              ]),
            ]),
          ]),
        ),
      ]),
    );
  }

  Widget _fareRow(String label, String value, {bool bold = false, bool positive = false, Color? textSub}) {
    final sub = textSub ?? Colors.grey.shade600;
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 3),
      child: Row(children: [
        Expanded(child: Text(label, style: TextStyle(fontSize: 12, color: sub))),
        Text(value, style: TextStyle(fontSize: 12,
          fontWeight: bold ? FontWeight.w500 : FontWeight.w500,
          color: positive ? _green : sub)),
      ]),
    );
  }

  Widget _buildPromoRow() {
    const cardBg = Color(0xFFF8FAFF);
    const borderCol = Color(0xFFE2E8F0);
    const textColor = JT.textPrimary;
    if (_appliedPromo != null) {
      return Container(
        padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 12),
        decoration: BoxDecoration(
          color: const Color(0xFFF0FDF4),
          borderRadius: BorderRadius.circular(12),
          border: Border.all(color: const Color(0xFF86EFAC))),
        child: Row(children: [
          const Icon(Icons.local_offer_rounded, color: Color(0xFF16A34A), size: 18),
          const SizedBox(width: 10),
          Expanded(child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Text('$_appliedPromo applied!',
              style: const TextStyle(fontWeight: FontWeight.w500, color: Color(0xFF16A34A), fontSize: 13)),
            Text('You save ₹${_promoDiscount.toInt()}',
              style: TextStyle(color: Colors.green[700], fontSize: 12)),
          ])),
          GestureDetector(
            onTap: () => setState(() { _appliedPromo = null; _promoDiscount = 0; _promoCtrl.clear(); }),
            child: const Icon(Icons.close_rounded, color: Color(0xFF16A34A), size: 20)),
        ]),
      );
    }
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 4),
      decoration: BoxDecoration(
        color: cardBg, borderRadius: BorderRadius.circular(12),
        border: Border.all(color: borderCol)),
      child: Column(children: [
        Row(children: [
          const Icon(Icons.local_offer_outlined, color: _jagoPrimary, size: 18),
          const SizedBox(width: 10),
          Expanded(
            child: TextField(
              controller: _promoCtrl,
              textCapitalization: TextCapitalization.characters,
              onChanged: _onCouponChanged,
              decoration: InputDecoration(
                hintText: 'Promo code',
                border: InputBorder.none, isDense: true,
                hintStyle: const TextStyle(fontSize: 13, color: Color(0xFFADB5BD))),
              style: TextStyle(fontSize: 13, fontWeight: FontWeight.w500, letterSpacing: 1.5, color: textColor),
            ),
          ),
          GestureDetector(
            onTap: _promoLoading ? null : _applyPromo,
            child: _promoLoading
              ? const SizedBox(width: 18, height: 18, child: CircularProgressIndicator(strokeWidth: 2, color: _jagoPrimary))
              : const Text('APPLY', style: TextStyle(color: _jagoPrimary, fontSize: 13, fontWeight: FontWeight.w400)),
          ),
        ]),
        if (_promoError != null)
          Padding(
            padding: const EdgeInsets.only(bottom: 8, left: 28),
            child: Text(_promoError!, style: const TextStyle(color: Color(0xFFDC2626), fontSize: 11))),
      ]),
    );
  }

  Widget _headerAction(IconData icon) {
    return Container(
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
      onTap: () => Navigator.pop(context),
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

class DashedLinePainter extends CustomPainter {
  final Color color;
  const DashedLinePainter({required this.color});
  @override
  void paint(Canvas canvas, Size size) {
    double dashHeight = 5, dashSpace = 3, startY = 0;
    final paint = Paint()..color = color..strokeWidth = 1;
    while (startY < size.height) {
      canvas.drawLine(Offset(0, startY), Offset(0, startY + dashHeight), paint);
      startY += dashHeight + dashSpace;
    }
  }
  @override
  bool shouldRepaint(DashedLinePainter oldDelegate) => oldDelegate.color != color;
}
