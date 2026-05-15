import 'dart:async';
import 'dart:convert';
import 'package:flutter/material.dart';
import 'package:geolocator/geolocator.dart';
import 'package:google_fonts/google_fonts.dart';
import 'package:http/http.dart' as http;
import '../../config/api_config.dart';
import '../../config/jago_theme.dart';
import '../../services/auth_service.dart';
import 'booking_screen.dart';
import 'map_location_picker.dart';
import '../wallet/wallet_screen.dart';
import '../notifications/notifications_screen.dart';
import 'parcel_booking_screen.dart';

class PremiumLocationScreen extends StatefulWidget {
  final String serviceType; // 'ride' or 'parcel'
  final String? pickupAddress;
  final double pickupLat;
  final double pickupLng;
  final String? vehicleCategoryId;
  final String? vehicleCategoryName;

  const PremiumLocationScreen({
    super.key,
    required this.serviceType,
    this.pickupAddress,
    this.pickupLat = 0,
    this.pickupLng = 0,
    this.vehicleCategoryId,
    this.vehicleCategoryName,
  });

  @override
  State<PremiumLocationScreen> createState() => _PremiumLocationScreenState();
}

class _PremiumLocationScreenState extends State<PremiumLocationScreen> {
  static const Color _ridePrimary = Color(0xFF6366F1);
  static const Color _ridePrimaryDark = Color(0xFF4F4ACF);
  static const Color _rideSecondary = Color(0xFFF43F5E);
  static const Color _parcelPrimary = Color(0xFFC29763);
  static const Color _parcelPrimaryDark = Color(0xFFB07D42);
  static const Color _parcelSecondary = Color(0xFFD6B58F);

  final TextEditingController _pickupCtrl = TextEditingController();
  final TextEditingController _dropCtrl = TextEditingController();
  final FocusNode _pickupFocus = FocusNode();
  final FocusNode _dropFocus = FocusNode();

  String _pickup = '';
  String _drop = '';
  double _pickupLat = 0;
  double _pickupLng = 0;
  double _dropLat = 0;
  double _dropLng = 0;

  List<dynamic> _searchResults = [];
  Timer? _debounce;
  bool _isTyping = false;
  bool _detectingLocation = false;
  bool _isSelectingSearchResult = false;
  bool _searchingPickupField = false;

  bool get _isParcel => widget.serviceType == 'parcel';
  Color get _primaryAccent => _isParcel ? _parcelPrimary : _ridePrimary;
  Color get _primaryAccentDark =>
      _isParcel ? _parcelPrimaryDark : _ridePrimaryDark;
  Color get _secondaryAccent =>
      _isParcel ? _parcelSecondary : _rideSecondary;
  LinearGradient get _ctaGradient => LinearGradient(
        colors: [_primaryAccent, _primaryAccentDark, _secondaryAccent],
        begin: Alignment.topLeft,
        end: Alignment.bottomRight,
      );

  @override
  void initState() {
    super.initState();
    _pickup = widget.pickupAddress ?? '';
    _pickupLat = widget.pickupLat;
    _pickupLng = widget.pickupLng;
    _pickupCtrl.text = _pickup;
    _pickupFocus.addListener(_onFocusChange);
    _dropFocus.addListener(_onFocusChange);
  }

  @override
  void dispose() {
    _pickupCtrl.dispose();
    _dropCtrl.dispose();
    _pickupFocus.dispose();
    _dropFocus.dispose();
    _debounce?.cancel();
    super.dispose();
  }

  void _onFocusChange() {
    if (mounted) {
      setState(() {
        _isTyping = _pickupFocus.hasFocus || _dropFocus.hasFocus;
      });
      if (!_pickupFocus.hasFocus &&
          !_dropFocus.hasFocus &&
          !_isSelectingSearchResult) {
        Future.delayed(const Duration(milliseconds: 120), () {
          if (!mounted) return;
          if (!_pickupFocus.hasFocus &&
              !_dropFocus.hasFocus &&
              !_isSelectingSearchResult) {
            setState(() => _searchResults = []);
          }
        });
      }
    }
  }

  Future<void> _detectLocation() async {
    setState(() => _detectingLocation = true);
    try {
      LocationPermission permission = await Geolocator.checkPermission();
      if (permission == LocationPermission.denied) {
        permission = await Geolocator.requestPermission();
      }
      Position p = await Geolocator.getCurrentPosition(
        locationSettings: const LocationSettings(accuracy: LocationAccuracy.best),
      );
      final addr = await _reverseGeocode(p.latitude, p.longitude);
      if (!mounted) return;
      setState(() {
        _pickup = addr;
        _pickupLat = p.latitude;
        _pickupLng = p.longitude;
        _pickupCtrl.text = addr;
        _detectingLocation = false;
      });
    } catch (e) {
      if (mounted) setState(() => _detectingLocation = false);
    }
  }

  Future<String> _reverseGeocode(double lat, double lng) async {
    try {
      final headers = await AuthService.getHeaders();
      final res = await http.get(
        Uri.parse('${ApiConfig.reverseGeocode}?lat=$lat&lng=$lng'),
        headers: headers,
      );
      if (res.statusCode == 200) {
        final data = json.decode(res.body) as Map<String, dynamic>;
        final addr = data['formattedAddress']?.toString();
        if (addr != null && addr.isNotEmpty) return addr;
      }
    } catch (_) {}
    return "Selected Location";
  }

  void _onSearch(String query, {required bool isPickup}) {
    _searchingPickupField = isPickup;
    _debounce?.cancel();
    _debounce = Timer(const Duration(milliseconds: 400), () async {
      final q = query.trim();
      if (q.length < 2) {
        if (mounted) setState(() => _searchResults = []);
        return;
      }
      try {
        final headers = await AuthService.getHeaders();
        final qp = StringBuffer('?query=${Uri.encodeComponent(q)}');
        if (_pickupLat != 0 && _pickupLng != 0) {
          qp.write('&lat=$_pickupLat&lng=$_pickupLng');
        }
        final res = await http.get(
          Uri.parse('${ApiConfig.placesAutocomplete}$qp'),
          headers: headers,
        );
        if (res.statusCode == 200) {
          final data = json.decode(res.body) as Map<String, dynamic>;
          final preds = (data['predictions'] as List<dynamic>? ?? []);
          if (mounted) setState(() => _searchResults = preds);
        }
      } catch (_) {}
    });
  }

  Future<void> _selectPlace(dynamic p, {required bool isPickup}) async {
    final placeId = p['placeId'] ?? p['place_id'];
    if (placeId == null) return;
    _isSelectingSearchResult = true;
    try {
      final headers = await AuthService.getHeaders();
      final res = await http.get(
        Uri.parse('${ApiConfig.placeDetails}?placeId=${Uri.encodeComponent(placeId.toString())}'),
        headers: headers,
      );
      if (res.statusCode == 200) {
        final data = json.decode(res.body) as Map<String, dynamic>;
        if (data['lat'] != null && data['lng'] != null) {
          final double lat = (data['lat'] as num).toDouble();
          final double lng = (data['lng'] as num).toDouble();
          String addr = data['address']?.toString() ??
              p['fullDescription']?.toString() ??
              p['description']?.toString() ??
              "Selected Location";
          if (mounted) {
            setState(() {
              if (isPickup) {
                _pickup = addr; _pickupLat = lat; _pickupLng = lng; _pickupCtrl.text = addr;
              } else {
                _drop = addr; _dropLat = lat; _dropLng = lng; _dropCtrl.text = addr;
              }
              _searchResults = [];
              FocusScope.of(context).unfocus();
            });
          }
        }
      }
    } catch (_) {
    } finally {
      _isSelectingSearchResult = false;
    }
  }

  void _swapLocations() {
    setState(() {
      final tTxt = _pickup; final tLat = _pickupLat; final tLng = _pickupLng;
      _pickup = _drop; _pickupLat = _dropLat; _pickupLng = _dropLng; _pickupCtrl.text = _pickup;
      _drop = tTxt; _dropLat = tLat; _dropLng = tLng; _dropCtrl.text = _drop;
    });
  }

  void _proceedToBooking() {
    if (_pickupLat == 0 || _dropLat == 0) return;
    if (widget.serviceType == 'parcel') {
      Navigator.push(context, MaterialPageRoute(builder: (context) => ParcelBookingScreen(
        pickupLat: _pickupLat, pickupLng: _pickupLng, dropLat: _dropLat, dropLng: _dropLng,
        pickupAddress: _pickup, dropAddress: _drop,
      )));
    } else {
      Navigator.push(context, MaterialPageRoute(builder: (context) => BookingScreen(
        pickup: _pickup, destination: _drop, pickupLat: _pickupLat, pickupLng: _pickupLng,
        destLat: _dropLat, destLng: _dropLng, vehicleCategoryId: widget.vehicleCategoryId,
        vehicleCategoryName: widget.vehicleCategoryName, category: widget.serviceType,
      )));
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: Colors.white,
      body: Stack(children: [
        Positioned(top: -100, right: -50, child: Container(width: 300, height: 300, decoration: BoxDecoration(shape: BoxShape.circle, color: _primaryAccent.withValues(alpha: 0.15)))),
        Positioned(top: 200, left: -80, child: Container(width: 250, height: 250, decoration: BoxDecoration(shape: BoxShape.circle, color: _secondaryAccent.withValues(alpha: 0.1)))),
        SafeArea(child: Column(children: [
          _buildHeader(),
          Expanded(child: Stack(children: [
            Positioned(bottom: -40, left: 0, right: 0, child: AnimatedSwitcher(duration: const Duration(milliseconds: 400), child: _isTyping ? const SizedBox.shrink() : Transform(
              transform: Matrix4.identity()..setEntry(3, 2, 0.001)..rotateX(0.08), alignment: Alignment.bottomCenter,
              child: Container(padding: const EdgeInsets.only(bottom: 20), child: Stack(alignment: Alignment.bottomCenter, children: [
                Container(width: 400, height: 400, decoration: BoxDecoration(shape: BoxShape.circle, gradient: RadialGradient(colors: [_primaryAccent.withValues(alpha: 0.1), Colors.transparent]))),
                Image.network('https://res.cloudinary.com/kits/image/upload/q_auto/f_auto/v1775197692/ride_image_qffoic.png', height: 350, fit: BoxFit.contain, errorBuilder: (_, __, ___) => const SizedBox.shrink()),
              ])),
            ))),
            SingleChildScrollView(physics: const BouncingScrollPhysics(), padding: const EdgeInsets.symmetric(horizontal: 20), child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              const SizedBox(height: 10),
              Text(_isParcel ? "Where to deliver?" : "Where to go?", style: GoogleFonts.poppins(fontSize: 28, fontWeight: FontWeight.w800, color: const Color(0xFF1E293B), letterSpacing: -1.0)),
              const SizedBox(height: 16),
              _buildRouteCard(),
              const SizedBox(height: 250),
            ])),
          ])),
        ])),
      ]),
    );
  }

  Widget _buildHeader() {
    return Container(padding: const EdgeInsets.symmetric(horizontal: 20, vertical: 10), child: Row(mainAxisAlignment: MainAxisAlignment.spaceBetween, children: [
      IconButton(onPressed: () => Navigator.pop(context), icon: const Icon(Icons.arrow_back_ios_new_rounded, color: Color(0xFF334155), size: 20), style: IconButton.styleFrom(backgroundColor: Colors.white, padding: const EdgeInsets.all(12))),
      JT.logoBlue(height: 28),
      Row(children: [
        IconButton(onPressed: () => Navigator.push(context, MaterialPageRoute(builder: (context) => const NotificationsScreen())), icon: const Icon(Icons.notifications_none_rounded, color: Color(0xFF64748B), size: 22), style: IconButton.styleFrom(backgroundColor: Colors.white, padding: const EdgeInsets.all(12))),
        const SizedBox(width: 12),
        GestureDetector(onTap: () => Navigator.push(context, MaterialPageRoute(builder: (context) => const WalletScreen())), child: Container(padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 10), decoration: BoxDecoration(color: Colors.white, borderRadius: BorderRadius.circular(16), boxShadow: [BoxShadow(color: Colors.black.withValues(alpha: 0.03), blurRadius: 10, offset: const Offset(0, 4))]), child: Row(children: [
          Icon(Icons.account_balance_wallet_rounded, color: _primaryAccent, size: 16),
          const SizedBox(width: 8),
          Text("Wallet", style: GoogleFonts.poppins(fontSize: 14, fontWeight: FontWeight.w600, color: const Color(0xFF1E293B))),
        ]))),
      ]),
    ]));
  }

  Widget _buildRouteCard() {
    return Container(padding: const EdgeInsets.all(24), decoration: BoxDecoration(color: Colors.white, borderRadius: BorderRadius.circular(30), boxShadow: [BoxShadow(color: Colors.black.withValues(alpha: 0.05), blurRadius: 30, offset: const Offset(0, 15))], border: Border.all(color: const Color(0xFFF1F5F9))), child: Column(children: [
      _buildLocationInput(title: "Pickup", hint: _isParcel ? "Pickup point?" : "Starting point?", controller: _pickupCtrl, focusNode: _pickupFocus, icon: Icons.my_location_rounded, iconColor: _primaryAccent, isPickup: true, loading: _detectingLocation && _pickup.isEmpty, onChanged: (value) => _onSearch(value, isPickup: true), trailing: GestureDetector(onTap: _detectLocation, child: Container(padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 4), decoration: BoxDecoration(color: _primaryAccent.withValues(alpha: 0.1), borderRadius: BorderRadius.circular(8)), child: Text("Current", style: GoogleFonts.poppins(fontSize: 12, fontWeight: FontWeight.w700, color: _primaryAccent))))),
      const SizedBox(height: 12),
      _buildDividerWithSwap(),
      const SizedBox(height: 12),
      _buildLocationInput(
        title: "Destination",
        hint: _isParcel
            ? "Where should we deliver?"
            : "Where are we going?",
        controller: _dropCtrl,
        focusNode: _dropFocus,
        icon: Icons.location_on_rounded,
        iconColor: _secondaryAccent,
        isPickup: false,
        onChanged: (value) => _onSearch(value, isPickup: false),
        trailing: GestureDetector(
          onTap: () {
            Navigator.push(
              context,
              MaterialPageRoute(builder: (context) => const MapLocationPicker()),
            ).then((res) {
              if (res != null) {
                setState(() {
                  _drop = res.address;
                  _dropLat = res.lat;
                  _dropLng = res.lng;
                  _dropCtrl.text = _drop;
                });
              }
            });
          },
          child: Container(
            padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 4),
            decoration: BoxDecoration(
              color: _secondaryAccent.withValues(alpha: 0.1),
              borderRadius: BorderRadius.circular(8),
            ),
            child: Text(
              "Map",
              style: GoogleFonts.poppins(
                fontSize: 12,
                fontWeight: FontWeight.w700,
                color: _secondaryAccent,
              ),
            ),
          ),
        ),
      ),
      AnimatedSwitcher(duration: const Duration(milliseconds: 300), child: (_isTyping && _searchResults.isNotEmpty) ? Column(children: [const SizedBox(height: 16), _buildSearchResults()]) : const SizedBox.shrink()),
      const SizedBox(height: 32),
      GestureDetector(onTap: _proceedToBooking, child: AnimatedContainer(duration: const Duration(milliseconds: 200), height: 58, decoration: BoxDecoration(gradient: (_pickupLat != 0 && _dropLat != 0) ? _ctaGradient : const LinearGradient(colors: [Color(0xFFE2E8F0), Color(0xFFE2E8F0)]), borderRadius: BorderRadius.circular(20), boxShadow: (_pickupLat != 0 && _dropLat != 0) ? [BoxShadow(color: _primaryAccentDark.withValues(alpha: 0.3), blurRadius: 25, offset: const Offset(0, 10))] : []), child: Center(child: Text((_pickup.isEmpty || _drop.isEmpty) ? (_isParcel ? "Set delivery route" : "Set your journey") : (_isParcel ? "Explore Premium Delivery" : "Explore Premium Rides"), style: GoogleFonts.poppins(fontSize: 17, fontWeight: FontWeight.w700, color: (_pickupLat != 0 && _dropLat != 0) ? Colors.white : const Color(0xFF94A3B8)))))),
    ]));
  }

  Widget _buildDividerWithSwap() {
    return Row(children: [
      const Expanded(child: Divider(color: Color(0xFFF1F5F9), thickness: 1)),
      Padding(padding: const EdgeInsets.symmetric(horizontal: 12), child: GestureDetector(onTap: _swapLocations, child: Container(padding: const EdgeInsets.all(8), decoration: BoxDecoration(color: _primaryAccent.withValues(alpha: 0.1), shape: BoxShape.circle), child: Icon(Icons.swap_vert_rounded, color: _primaryAccent, size: 22)))),
      const Expanded(child: Divider(color: Color(0xFFF1F5F9), thickness: 1)),
    ]);
  }

  Widget _buildLocationInput({required String title, required String hint, required TextEditingController controller, required FocusNode focusNode, required IconData icon, required Color iconColor, required bool isPickup, bool loading = false, Widget? trailing, required Function(String) onChanged}) {
    return Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
      Row(mainAxisAlignment: MainAxisAlignment.spaceBetween, children: [Text(title.toUpperCase(), style: GoogleFonts.poppins(fontSize: 10, fontWeight: FontWeight.w800, color: isPickup ? _primaryAccent : _secondaryAccent, letterSpacing: 1.2)), if (trailing != null) trailing]),
      const SizedBox(height: 10),
      TextField(controller: controller, focusNode: focusNode, onChanged: onChanged, style: GoogleFonts.poppins(fontSize: 15, fontWeight: FontWeight.w600, color: const Color(0xFF1E293B)), decoration: InputDecoration(hintText: loading ? "Locating you..." : hint, hintStyle: GoogleFonts.poppins(fontSize: 14, color: const Color(0xFFCBD5E1), fontWeight: FontWeight.w400), prefixIcon: Icon(icon, color: iconColor, size: 22), filled: true, fillColor: const Color(0xFFF8FAFC), contentPadding: const EdgeInsets.symmetric(horizontal: 16, vertical: 18), enabledBorder: OutlineInputBorder(borderRadius: BorderRadius.circular(16), borderSide: const BorderSide(color: Color(0xFFF1F5F9), width: 1.5)), focusedBorder: OutlineInputBorder(borderRadius: BorderRadius.circular(16), borderSide: BorderSide(color: iconColor, width: 2)), suffixIcon: loading ? Padding(padding: const EdgeInsets.all(12), child: SizedBox(width: 16, height: 16, child: CircularProgressIndicator(strokeWidth: 2, color: _primaryAccent))) : null)),
    ]);
  }

  Widget _buildSearchResults() {
    return Container(constraints: const BoxConstraints(maxHeight: 250), decoration: BoxDecoration(color: Colors.white, borderRadius: BorderRadius.circular(20), border: Border.all(color: const Color(0xFFF1F5F9))), child: ListView.separated(shrinkWrap: true, padding: EdgeInsets.zero, itemCount: _searchResults.length, separatorBuilder: (context, index) => const Divider(height: 1, color: Color(0xFFF1F5F9)), itemBuilder: (context, index) {
      final p = _searchResults[index];
      final mainText = p['mainText']?.toString() ??
          p['structured_formatting']?['main_text']?.toString() ??
          p['description']?.toString().split(',').first ??
          'Location';
      final secText = p['secondaryText']?.toString() ??
          p['structured_formatting']?['secondary_text']?.toString() ??
          '';
      return ListTile(contentPadding: const EdgeInsets.symmetric(horizontal: 16, vertical: 8), leading: Icon(Icons.location_on_rounded, color: _primaryAccent, size: 20), title: Text(mainText, style: GoogleFonts.poppins(fontSize: 14, fontWeight: FontWeight.w600, color: const Color(0xFF1E293B))), subtitle: secText.isNotEmpty ? Text(secText, style: GoogleFonts.poppins(fontSize: 11, color: const Color(0xFF64748B)), maxLines: 1, overflow: TextOverflow.ellipsis) : null, onTap: () => _selectPlace(p, isPickup: _searchingPickupField));
    }));
  }
}
