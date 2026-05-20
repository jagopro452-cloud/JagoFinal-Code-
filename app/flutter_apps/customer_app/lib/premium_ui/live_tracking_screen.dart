import 'package:flutter/material.dart';
import 'package:google_maps_flutter/google_maps_flutter.dart';
import 'package:geolocator/geolocator.dart';
import 'dart:async';
import 'theme.dart';
import 'glass_card.dart';

class LiveTrackingScreen extends StatefulWidget {
  const LiveTrackingScreen({super.key});

  @override
  State<LiveTrackingScreen> createState() => _LiveTrackingScreenState();
}

class _LiveTrackingScreenState extends State<LiveTrackingScreen> {
  GoogleMapController? _mapController;
  LatLng? _currentLatLng;
  StreamSubscription<Position>? _positionStream;
  Marker? _userMarker;
  bool _locationLoading = true;
  bool _isFollowing = true; // Prevents map snapping if user pans manually
  bool _hasLocationPermission = false;

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
        _locationLoading = false;
        _hasLocationPermission = false;
      });
      return;
    }
    if (mounted) {
      setState(() => _hasLocationPermission = true);
    }
    bool serviceEnabled = await Geolocator.isLocationServiceEnabled();
    if (!serviceEnabled) {
      setState(() {
        _locationLoading = false;
      });
      return;
    }
    try {
      Position pos = await Geolocator.getCurrentPosition(
        locationSettings: const LocationSettings(accuracy: LocationAccuracy.high, timeLimit: Duration(seconds: 10)),
      );
      _updateLocation(pos);
      _positionStream = Geolocator.getPositionStream(
        locationSettings: const LocationSettings(accuracy: LocationAccuracy.high, distanceFilter: 10),
      ).listen((Position position) {
        _updateLocation(position);
      });
    } catch (_) {}
    if (mounted) setState(() { _locationLoading = false; });
  }

  void _updateLocation(Position pos) {
    if (!mounted) return;
    if (pos.latitude == 0 && pos.longitude == 0) return;
    final latLng = LatLng(pos.latitude, pos.longitude);
    setState(() {
      _currentLatLng = latLng;
      _userMarker = Marker(
        markerId: const MarkerId('user'),
        position: latLng,
        icon: BitmapDescriptor.defaultMarkerWithHue(BitmapDescriptor.hueAzure),
      );
    });
    if (_mapController != null && _isFollowing) {
      _mapController!.animateCamera(CameraUpdate.newLatLng(latLng));
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
      appBar: AppBar(
        backgroundColor: Colors.transparent,
        elevation: 0,
        leading: IconButton(
          icon: const Icon(Icons.arrow_back_ios_new_rounded, color: JagoTheme.primaryBlue),
          onPressed: () => Navigator.pop(context),
        ),
        title: Text('Live Tracking', style: TextStyle(color: JagoTheme.textDark, fontWeight: FontWeight.bold)),
        centerTitle: true,
      ),
      body: Stack(
        children: [
          // Map
          Positioned.fill(
            child: GoogleMap(
              initialCameraPosition: CameraPosition(
                target: _currentLatLng ?? const LatLng(20.5937, 78.9629),
                zoom: 15,
              ),
              myLocationEnabled: _hasLocationPermission,
              myLocationButtonEnabled: _hasLocationPermission,
              zoomControlsEnabled: false,
              onCameraMoveStarted: () {
                // If user touches the map, stop auto-snapping to current location
                if (_locationLoading == false) {
                  setState(() => _isFollowing = false);
                }
              },
              markers: _userMarker != null ? {_userMarker!} : {},
              onMapCreated: (controller) {
                _mapController = controller;
                if (_currentLatLng != null) {
                  _mapController!.animateCamera(CameraUpdate.newLatLng(_currentLatLng!));
                }
              },
            ),
          ),
          // Re-center button (shows up when following is disabled)
          if (!_isFollowing && _currentLatLng != null)
            Positioned(
              right: 16,
              top: 100,
              child: FloatingActionButton.small(
                backgroundColor: Colors.white,
                onPressed: () {
                  setState(() => _isFollowing = true);
                  _mapController?.animateCamera(CameraUpdate.newLatLng(_currentLatLng!));
                },
                child: const Icon(Icons.my_location, color: JagoTheme.primaryBlue),
              ),
            ),
          // Driver info card
          Align(
            alignment: Alignment.bottomCenter,
            child: Padding(
              padding: const EdgeInsets.fromLTRB(16, 0, 16, 32),
              child: GlassCard(
                child: Row(
                  children: [
                    CircleAvatar(
                      radius: 28,
                      backgroundColor: JagoTheme.primaryBlue.withValues(alpha: 0.12),
                      child: const Icon(Icons.person, color: JagoTheme.primaryBlue, size: 32),
                    ),
                    const SizedBox(width: 16),
                    Expanded(
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: const [
                          Text('Driver is on the way', style: TextStyle(fontWeight: FontWeight.bold, fontSize: 16)),
                          SizedBox(height: 6),
                          Text('Arriving in 4 min', style: TextStyle(color: JagoTheme.primaryBlue, fontWeight: FontWeight.w500)),
                        ],
                      ),
                    ),
                    IconButton(
                      icon: const Icon(Icons.call, color: JagoTheme.primaryBlue),
                      onPressed: () {},
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
