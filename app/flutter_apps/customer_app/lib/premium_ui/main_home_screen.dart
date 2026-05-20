import 'package:flutter/material.dart';
import 'package:google_maps_flutter/google_maps_flutter.dart';
import 'package:geolocator/geolocator.dart';
import 'dart:async';
import 'theme.dart';
import 'glass_card.dart';

class MainHomeScreen extends StatefulWidget {
  const MainHomeScreen({super.key});

  @override
  State<MainHomeScreen> createState() => _MainHomeScreenState();
}

class _MainHomeScreenState extends State<MainHomeScreen> {
  GoogleMapController? _mapController;
  LatLng? _currentLatLng;
  StreamSubscription<Position>? _positionStream;
  Marker? _userMarker;
  String _locationStatus = 'Detecting location...';
  bool _isFollowing = true;
  double _mapPadding = 0;

  @override
  void initState() {
    super.initState();
    // Automatic location trigger on start
    _initLocation();
  }

  Future<void> _initLocation() async {
    LocationPermission perm = await Geolocator.checkPermission();
    if (perm == LocationPermission.denied) {
      perm = await Geolocator.requestPermission();
    }
    if (perm == LocationPermission.denied || perm == LocationPermission.deniedForever) {
      setState(() {
        _locationStatus = 'Location permission denied';
      });
      return;
    }
    bool serviceEnabled = await Geolocator.isLocationServiceEnabled();
    if (!serviceEnabled) {
      setState(() {
        _locationStatus = 'GPS is OFF. Enable location.';
      });
      return;
    }
    try {
      Position pos = await Geolocator.getCurrentPosition(
        locationSettings: const LocationSettings(accuracy: LocationAccuracy.high, timeLimit: Duration(seconds: 10)),
      );
      if (mounted) {
        _updateLocation(pos);
      }
      
      _positionStream = Geolocator.getPositionStream(
        locationSettings: const LocationSettings(accuracy: LocationAccuracy.high, distanceFilter: 10),
      ).listen((Position position) {
        if (mounted) _updateLocation(position);
      });
    } catch (_) {}
    if (mounted) {
      setState(() {});
    }
  }

  void _updateLocation(Position pos) {
    if (!mounted) return;
    if (pos.latitude == 0 && pos.longitude == 0) return;
    final latLng = LatLng(pos.latitude, pos.longitude);
    setState(() {
      _currentLatLng = latLng;
      _userMarker = Marker(
        markerId: const MarkerId('current_user_loc'),
        position: latLng,
        icon: BitmapDescriptor.defaultMarkerWithHue(BitmapDescriptor.hueAzure),
      );
      _locationStatus = 'You are here';
    });
    if (_mapController != null && _isFollowing && _currentLatLng != null) {
      _mapController!.animateCamera(CameraUpdate.newLatLngZoom(latLng, 15));
    }
  }

  @override
  void dispose() {
    _positionStream?.cancel();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      extendBodyBehindAppBar: true,
      body: Stack(
        children: [
          // Full screen Google Map
          Positioned.fill(
            child: GoogleMap(
              initialCameraPosition: CameraPosition(
                target: _currentLatLng ?? const LatLng(20.5937, 78.9629),
                zoom: 15,
              ),
              myLocationEnabled: true,
              myLocationButtonEnabled: false,
              padding: EdgeInsets.only(bottom: _mapPadding + 20, top: 100),
              zoomControlsEnabled: false,
              onCameraMoveStarted: () {
                if (mounted) setState(() => _isFollowing = false);
              },
              markers: _userMarker != null ? {_userMarker!} : {},
              onMapCreated: (controller) {
                if (mounted) {
                  setState(() {
                    _mapController = controller;
                    _mapPadding = 350; 
                  });
                }
                if (_currentLatLng != null) {
                  _mapController!.animateCamera(CameraUpdate.newLatLngZoom(_currentLatLng!, 15));
                }
              },
            ),
          ),
          // Re-center button
          if (!_isFollowing && _currentLatLng != null)
            Positioned(
              right: 20,
              bottom: _mapPadding + 40,
              child: FloatingActionButton.small(
                backgroundColor: Colors.white,
                onPressed: () {
                  setState(() => _isFollowing = true);
                  _mapController?.animateCamera(CameraUpdate.newLatLngZoom(_currentLatLng!, 15));
                },
                child: const Icon(Icons.my_location, color: JagoTheme.primaryBlue),
              ),
            ),
          // Top bar
          SafeArea(
            child: Padding(
              padding: const EdgeInsets.symmetric(horizontal: 20, vertical: 12),
              child: Row(
                mainAxisAlignment: MainAxisAlignment.spaceBetween,
                children: [
                  CircleAvatar(
                    radius: 22,
                    backgroundColor: JagoTheme.primaryBlue.withValues(alpha: 0.12),
                    child: const Icon(Icons.person, color: JagoTheme.primaryBlue, size: 28),
                  ),
                  Row(
                    children: [
                      const Icon(Icons.location_on_rounded, color: JagoTheme.primaryBlue, size: 22),
                      const SizedBox(width: 6),
                      Text(
                        _locationStatus,
                        style: TextStyle(
                          color: JagoTheme.textDark.withValues(alpha: 0.85),
                          fontWeight: FontWeight.w600,
                          fontSize: 15,
                        ),
                      ),
                    ],
                  ),
                ],
              ),
            ),
          ),
          // Bottom glass card
          Align(
            alignment: Alignment.bottomCenter,
            child: Padding(
              padding: const EdgeInsets.fromLTRB(16, 0, 16, 32),
              child: GlassCard(
                padding: const EdgeInsets.symmetric(horizontal: 20, vertical: 24),
                child: Column(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    // Where to input
                    Container(
                      decoration: BoxDecoration(
                        color: Colors.white.withValues(alpha: 0.85),
                        borderRadius: BorderRadius.circular(16),
                        boxShadow: [
                          BoxShadow(
                            color: JagoTheme.primaryBlue.withValues(alpha: 0.06),
                            blurRadius: 12,
                            offset: const Offset(0, 4),
                          ),
                        ],
                      ),
                      child: TextField(
                        decoration: InputDecoration(
                          hintText: 'Where to?',
                          hintStyle: TextStyle(color: JagoTheme.textDark.withValues(alpha: 0.5)),
                          border: InputBorder.none,
                          prefixIcon: const Icon(Icons.search, color: JagoTheme.primaryBlue),
                          contentPadding: const EdgeInsets.symmetric(vertical: 16, horizontal: 12),
                        ),
                        style: const TextStyle(fontSize: 17, fontWeight: FontWeight.w500),
                        readOnly: true,
                        onTap: () {
                          Navigator.pushNamed(context, '/booking');
                        },
                      ),
                    ),
                    const SizedBox(height: 18),
                    // Ride options
                    Row(
                      mainAxisAlignment: MainAxisAlignment.spaceEvenly,
                      children: [
                        // Assets folder lo ee images undali: assets/images/bike.png, etc.
                        _RideOption(imagePath: 'assets/images/bike.png', fallbackIcon: Icons.electric_bike_rounded, label: 'Bike'),
                        _RideOption(imagePath: 'assets/images/auto.png', fallbackIcon: Icons.electric_rickshaw_rounded, label: 'Auto'),
                        _RideOption(imagePath: 'assets/images/parcel.png', fallbackIcon: Icons.local_shipping_rounded, label: 'Parcel'),
                      ],
                    ),
                    const SizedBox(height: 24),
                    // Book Ride CTA
                    SizedBox(
                      width: double.infinity,
                      child: ElevatedButton(
                        style: ElevatedButton.styleFrom(
                          padding: const EdgeInsets.symmetric(vertical: 18),
                          shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(18)),
                          elevation: 0,
                          backgroundColor: Colors.transparent,
                          shadowColor: Colors.transparent,
                          surfaceTintColor: Colors.transparent,
                        ),
                        onPressed: () {
                          Navigator.pushNamed(context, '/booking');
                        },
                        child: Ink(
                          decoration: BoxDecoration(
                            gradient: JagoTheme.primaryGradient,
                            borderRadius: BorderRadius.circular(18),
                          ),
                          child: Container(
                            alignment: Alignment.center,
                            child: const Text(
                              'Book Ride',
                              style: TextStyle(
                                color: Colors.white,
                                fontWeight: FontWeight.bold,
                                fontSize: 18,
                                letterSpacing: 0.2,
                              ),
                            ),
                          ),
                        ),
                      ),
                    ),
                  ],
                ),
              ),
            ),
          ),
        ],
      ),
    );
  }
}

class _RideOption extends StatelessWidget {
  final String imagePath;
  final IconData fallbackIcon;
  final String label;
  const _RideOption({required this.imagePath, required this.fallbackIcon, required this.label});

  @override
  Widget build(BuildContext context) {
    return Column(
      children: [
        Container(
          decoration: BoxDecoration(
            gradient: JagoTheme.primaryGradient,
            borderRadius: BorderRadius.circular(16),
            boxShadow: [
              BoxShadow(
                color: JagoTheme.primaryBlue.withValues(alpha: 0.10),
                blurRadius: 10,
                offset: const Offset(0, 4),
              ),
            ],
          ),
          padding: const EdgeInsets.all(14),
          child: Image.asset(
            imagePath,
            width: 32,
            height: 32,
            errorBuilder: (context, error, stackTrace) {
              return Icon(fallbackIcon, color: Colors.white, size: 28);
            },
          ),
        ),
        const SizedBox(height: 8),
        Text(label, style: TextStyle(color: JagoTheme.textDark.withValues(alpha: 0.85), fontWeight: FontWeight.w600)),
      ],
    );
  }
}
