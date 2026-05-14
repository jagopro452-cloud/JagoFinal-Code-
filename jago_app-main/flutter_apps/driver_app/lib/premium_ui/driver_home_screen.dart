import 'package:flutter/material.dart';
import 'package:google_maps_flutter/google_maps_flutter.dart';
import 'package:geolocator/geolocator.dart';
import 'dart:async';
import 'theme.dart';
import 'glass_card.dart';

class DriverHomeScreen extends StatefulWidget {
  const DriverHomeScreen({super.key});

  @override
  State<DriverHomeScreen> createState() => _DriverHomeScreenState();
}

class _DriverHomeScreenState extends State<DriverHomeScreen> {
  GoogleMapController? _mapController;
  LatLng? _currentLatLng;
  StreamSubscription<Position>? _positionStream;
  Marker? _userMarker;
  double _mapPadding = 0;
  bool _isFollowing = true;
  bool _isOnline = false;

  @override
  void initState() {
    super.initState();
    _initLocation();
  }

  Future<void> _initLocation() async {
    LocationPermission perm = await Geolocator.checkPermission();
    if (perm == LocationPermission.denied) {
      perm = await Geolocator.requestPermission();
    }
    if (perm == LocationPermission.denied || perm == LocationPermission.deniedForever) {
      setState(() {
      });
      return;
    }
    bool serviceEnabled = await Geolocator.isLocationServiceEnabled();
    if (!serviceEnabled) {
      setState(() {
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
  }

  void _updateLocation(Position pos) {
    if (!mounted) return;
    if (pos.latitude == 0 && pos.longitude == 0) return;
    final latLng = LatLng(pos.latitude, pos.longitude);
    setState(() {
      _currentLatLng = latLng;
      _userMarker = Marker(
        markerId: const MarkerId('driver_loc'),
        position: latLng,
        icon: BitmapDescriptor.defaultMarkerWithHue(BitmapDescriptor.hueAzure),
      );
    });
    if (_mapController != null && _isFollowing) {
      _mapController!.animateCamera(CameraUpdate.newLatLngZoom(latLng, 15));
    }
  }

  @override
  void dispose() {
    _positionStream?.cancel();
    _mapController?.dispose();
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
              padding: EdgeInsets.only(bottom: _mapPadding + 40, top: 100),
              onCameraMoveStarted: () {
                if (mounted) setState(() => _isFollowing = false);
              },
              markers: _userMarker != null ? {_userMarker!} : {},
              onMapCreated: (controller) {
                if (mounted) {
                  setState(() {
                    _mapController = controller;
                    _mapPadding = 320; 
                  });
                }
                if (_currentLatLng != null) {
                  _mapController!.animateCamera(CameraUpdate.newLatLngZoom(_currentLatLng!, 15));
                }
              },
            ),
          ),
          // Top earnings/trips
          SafeArea(
            child: Padding(
              padding: const EdgeInsets.symmetric(horizontal: 20, vertical: 12),
              child: Row(
                mainAxisAlignment: MainAxisAlignment.spaceBetween,
                children: [
                  GlassCard(
                    padding: const EdgeInsets.symmetric(horizontal: 18, vertical: 12),
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: const [
                        Text('Earnings', style: TextStyle(fontSize: 13, color: JagoTheme.textDark, fontWeight: FontWeight.w500)),
                        SizedBox(height: 4),
                        Text('₹0', style: TextStyle(fontSize: 18, color: JagoTheme.primaryBlue, fontWeight: FontWeight.bold)),
                      ],
                    ),
                  ),
                  GlassCard(
                    padding: const EdgeInsets.symmetric(horizontal: 18, vertical: 12),
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: const [
                        Text('Trips', style: TextStyle(fontSize: 13, color: JagoTheme.textDark, fontWeight: FontWeight.w500)),
                        SizedBox(height: 4),
                        Text('0', style: TextStyle(fontSize: 18, color: JagoTheme.primaryBlue, fontWeight: FontWeight.bold)),
                      ],
                    ),
                  ),
                ],
              ),
            ),
          ),
          // Center GO ONLINE button
          Center(
            child: GestureDetector(
              onTap: () {
                setState(() {
                  _isOnline = !_isOnline;
                });
                ScaffoldMessenger.of(context).showSnackBar(
                  SnackBar(
                    content: Text(_isOnline ? 'You are now Online' : 'You are now Offline'),
                    backgroundColor: _isOnline ? JagoTheme.success : JagoTheme.textDark,
                  ),
                );
              },
              child: GlassCard(
                padding: const EdgeInsets.symmetric(horizontal: 40, vertical: 30),
                borderRadius: 40,
                color: _isOnline ? JagoTheme.success.withValues(alpha: 0.2) : null,
                child: Column(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    Icon(
                      _isOnline ? Icons.check_circle_rounded : Icons.power_settings_new_rounded,
                      color: _isOnline ? JagoTheme.success : JagoTheme.success,
                      size: 48,
                    ),
                    const SizedBox(height: 12),
                    Text(
                      _isOnline ? 'ONLINE' : 'GO ONLINE',
                      style: TextStyle(
                        color: _isOnline ? JagoTheme.success : JagoTheme.success,
                        fontWeight: FontWeight.bold,
                        fontSize: 24,
                        letterSpacing: 1.5,
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
