import 'dart:convert';
import 'package:flutter/material.dart';
import 'package:geolocator/geolocator.dart';
import 'package:google_fonts/google_fonts.dart';
import 'package:http/http.dart' as http;
import 'package:url_launcher/url_launcher.dart';
import '../../config/api_config.dart';
import '../../config/jago_theme.dart';
import '../../services/auth_service.dart';

class OutstationPoolDriverScreen extends StatefulWidget {
  const OutstationPoolDriverScreen({super.key});

  @override
  State<OutstationPoolDriverScreen> createState() =>
      _OutstationPoolDriverScreenState();
}

class _OutstationPoolDriverScreenState extends State<OutstationPoolDriverScreen> {
  bool _loading = true;
  bool _creating = false;
  List<Map<String, dynamic>> _rides = [];

  final _fromCtrl = TextEditingController();
  final _toCtrl = TextEditingController();
  final _dateCtrl = TextEditingController();
  final _timeCtrl = TextEditingController();
  final _seatsCtrl = TextEditingController(text: '4');
  final _fareCtrl = TextEditingController();
  final _routeKmCtrl = TextEditingController();
  final _vehicleNumberCtrl = TextEditingController();
  final _vehicleModelCtrl = TextEditingController();
  final _noteCtrl = TextEditingController();

  @override
  void initState() {
    super.initState();
    _loadRides();
  }

  @override
  void dispose() {
    _fromCtrl.dispose();
    _toCtrl.dispose();
    _dateCtrl.dispose();
    _timeCtrl.dispose();
    _seatsCtrl.dispose();
    _fareCtrl.dispose();
    _routeKmCtrl.dispose();
    _vehicleNumberCtrl.dispose();
    _vehicleModelCtrl.dispose();
    _noteCtrl.dispose();
    super.dispose();
  }

  Future<void> _loadRides() async {
    if (mounted) setState(() => _loading = true);
    try {
      final headers = await AuthService.getHeaders();
      final res = await http.get(
        Uri.parse(ApiConfig.driverOutstationPoolRides),
        headers: headers,
      ).timeout(const Duration(seconds: 10));
      if (res.statusCode == 200) {
        final data = jsonDecode(res.body) as Map<String, dynamic>;
        final rows = (data['data'] as List? ?? [])
            .whereType<Map>()
            .map((e) => Map<String, dynamic>.from(e))
            .toList();
        if (mounted) setState(() => _rides = rows);
      }
    } catch (_) {}
    if (mounted) setState(() => _loading = false);
  }

  Future<void> _pickDate() async {
    final now = DateTime.now();
    final picked = await showDatePicker(
      context: context,
      initialDate: now,
      firstDate: now,
      lastDate: now.add(const Duration(days: 90)),
    );
    if (picked != null) {
      _dateCtrl.text =
          '${picked.year.toString().padLeft(4, '0')}-${picked.month.toString().padLeft(2, '0')}-${picked.day.toString().padLeft(2, '0')}';
      if (mounted) setState(() {});
    }
  }

  Future<void> _pickTime() async {
    final picked = await showTimePicker(
      context: context,
      initialTime: const TimeOfDay(hour: 8, minute: 0),
    );
    if (picked != null) {
      _timeCtrl.text =
          '${picked.hour.toString().padLeft(2, '0')}:${picked.minute.toString().padLeft(2, '0')}';
      if (mounted) setState(() {});
    }
  }

  Future<void> _createRide() async {
    if (_fromCtrl.text.trim().isEmpty || _toCtrl.text.trim().isEmpty) {
      _snack('From and To cities are required', error: true);
      return;
    }
    if (_fareCtrl.text.trim().isEmpty) {
      _snack('Fare per seat is required', error: true);
      return;
    }
    setState(() => _creating = true);
    try {
      final headers = await AuthService.getHeaders();
      final res = await http.post(
        Uri.parse(ApiConfig.driverOutstationPoolRides),
        headers: {...headers, 'Content-Type': 'application/json'},
        body: jsonEncode({
          'fromCity': _fromCtrl.text.trim(),
          'toCity': _toCtrl.text.trim(),
          'routeKm': _routeKmCtrl.text.trim(),
          'departureDate': _dateCtrl.text.trim().isEmpty ? null : _dateCtrl.text.trim(),
          'departureTime': _timeCtrl.text.trim().isEmpty ? null : _timeCtrl.text.trim(),
          'totalSeats': _seatsCtrl.text.trim(),
          'vehicleNumber': _vehicleNumberCtrl.text.trim(),
          'vehicleModel': _vehicleModelCtrl.text.trim(),
          'farePerSeat': _fareCtrl.text.trim(),
          'note': _noteCtrl.text.trim(),
        }),
      ).timeout(const Duration(seconds: 15));
      final data = jsonDecode(res.body) as Map<String, dynamic>;
      if (!mounted) return;
      if (res.statusCode == 200) {
        _snack('Outstation pool ride created');
        _clearForm();
        await _loadRides();
      } else {
        _snack(data['message']?.toString() ?? 'Could not create ride', error: true);
      }
    } catch (_) {
      _snack('Network error while creating ride', error: true);
    }
    if (mounted) setState(() => _creating = false);
  }

  void _clearForm() {
    _fromCtrl.clear();
    _toCtrl.clear();
    _dateCtrl.clear();
    _timeCtrl.clear();
    _seatsCtrl.text = '4';
    _fareCtrl.clear();
    _routeKmCtrl.clear();
    _vehicleNumberCtrl.clear();
    _vehicleModelCtrl.clear();
    _noteCtrl.clear();
  }

  Future<void> _toggleRide(Map<String, dynamic> ride) async {
    final id = ride['id']?.toString() ?? '';
    if (id.isEmpty) return;
    final isActive = !(ride['isActive'] == true || ride['is_active'] == true);
    await _patchRide(id, {'isActive': isActive});
  }

  Future<void> _showPassengerManifest(String rideId, int bookings) async {
    if (bookings == 0) { _snack('No passengers booked yet'); return; }
    showDialog(
      context: context,
      barrierDismissible: false,
      builder: (_) => const AlertDialog(content: SizedBox(height: 60, child: Center(child: CircularProgressIndicator()))),
    );
    try {
      final headers = await AuthService.getHeaders();
      final res = await http.get(
        Uri.parse(ApiConfig.driverOutstationPoolBookings(rideId)),
        headers: headers,
      ).timeout(const Duration(seconds: 10));
      if (!mounted) return;
      Navigator.pop(context);
      if (res.statusCode == 200) {
        final data = jsonDecode(res.body) as Map<String, dynamic>;
        final passengers = (data['passengers'] ?? data['bookings'] ?? data['data'] ?? []) as List;
        _showManifestDialog(passengers.whereType<Map>().map((e) => Map<String, dynamic>.from(e)).toList());
      } else {
        _snack('Could not load passengers.', error: true);
      }
    } catch (_) {
      if (mounted) { Navigator.pop(context); _snack('Network error.', error: true); }
    }
  }

  void _showManifestDialog(List<Map<String, dynamic>> passengers) {
    showModalBottomSheet(
      context: context,
      isScrollControlled: true,
      backgroundColor: Colors.transparent,
      builder: (_) => DraggableScrollableSheet(
        initialChildSize: 0.55,
        minChildSize: 0.35,
        maxChildSize: 0.9,
        builder: (_, ctrl) => Container(
          decoration: const BoxDecoration(color: Colors.white, borderRadius: BorderRadius.vertical(top: Radius.circular(20))),
          child: Column(children: [
            const SizedBox(height: 8),
            Container(width: 40, height: 4, decoration: BoxDecoration(color: Colors.grey[300], borderRadius: BorderRadius.circular(2))),
            Padding(
              padding: const EdgeInsets.fromLTRB(16, 12, 16, 8),
              child: Row(children: [
                Icon(Icons.people_rounded, color: JT.primary, size: 20),
                const SizedBox(width: 8),
                Text('Passengers (${passengers.length})', style: GoogleFonts.poppins(fontWeight: FontWeight.w600, fontSize: 15)),
              ]),
            ),
            const Divider(height: 1),
            Expanded(
              child: passengers.isEmpty
                  ? Center(child: Text('No passengers yet', style: GoogleFonts.poppins(color: JT.textSecondary)))
                  : ListView.separated(
                      controller: ctrl,
                      padding: const EdgeInsets.all(16),
                      itemCount: passengers.length,
                      separatorBuilder: (_, __) => const Divider(height: 16),
                      itemBuilder: (_, i) {
                        final p = passengers[i];
                        final name = p['passengerName']?.toString() ?? p['customerName']?.toString() ?? 'Passenger ${i + 1}';
                        final phone = p['passengerPhone']?.toString() ?? p['customerPhone']?.toString() ?? '';
                        final seats = p['seatsBooked'] ?? p['seats_booked'] ?? 1;
                        final pickup = p['pickupAddress']?.toString() ?? '';
                        final drop = p['dropoffAddress']?.toString() ?? '';
                        return Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
                          Container(
                            width: 36, height: 36,
                            decoration: BoxDecoration(color: JT.primary.withValues(alpha: 0.1), shape: BoxShape.circle),
                            child: Center(child: Text(name.isNotEmpty ? name[0].toUpperCase() : '?',
                                style: TextStyle(color: JT.primary, fontWeight: FontWeight.w600))),
                          ),
                          const SizedBox(width: 10),
                          Expanded(child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                            Text(name, style: GoogleFonts.poppins(fontWeight: FontWeight.w500, fontSize: 13)),
                            Text('$seats seat${seats == 1 ? '' : 's'}${pickup.isNotEmpty ? ' · Pickup: $pickup' : ''}${drop.isNotEmpty ? ' · Drop: $drop' : ''}',
                                style: GoogleFonts.poppins(fontSize: 11, color: JT.textSecondary)),
                          ])),
                          if (phone.isNotEmpty)
                            GestureDetector(
                              onTap: () => launchUrl(Uri.parse('tel:$phone')),
                              child: Padding(
                                padding: const EdgeInsets.only(left: 8),
                                child: Icon(Icons.call_rounded, size: 18, color: JT.primary),
                              ),
                            ),
                        ]);
                      },
                    ),
            ),
          ]),
        ),
      ),
    );
  }

  Future<void> _startRide(Map<String, dynamic> ride) async {
    final id = ride['id']?.toString() ?? '';
    if (id.isEmpty) return;
    double? lat;
    double? lng;
    try {
      final pos = await Geolocator.getCurrentPosition(
        locationSettings: const LocationSettings(accuracy: LocationAccuracy.high),
      );
      lat = pos.latitude;
      lng = pos.longitude;
    } catch (_) {}
    try {
      final headers = await AuthService.getHeaders();
      final res = await http.post(
        Uri.parse(ApiConfig.driverOutstationPoolStart(id)),
        headers: {...headers, 'Content-Type': 'application/json'},
        body: jsonEncode({
          if (lat != null) 'lat': lat,
          if (lng != null) 'lng': lng,
        }),
      ).timeout(const Duration(seconds: 10));
      final data = jsonDecode(res.body) as Map<String, dynamic>;
      if (!mounted) return;
      if (res.statusCode == 200) {
        _snack('Trip started! Passengers notified.');
        await _loadRides();
      } else {
        _snack(data['message']?.toString() ?? 'Could not start ride', error: true);
      }
    } catch (_) {
      _snack('Network error while starting ride', error: true);
    }
  }

  Future<void> _completeRide(Map<String, dynamic> ride) async {
    final id = ride['id']?.toString() ?? '';
    if (id.isEmpty) return;
    try {
      final headers = await AuthService.getHeaders();
      final res = await http.post(
        Uri.parse(ApiConfig.driverCompleteOutstationPoolRide(id)),
        headers: headers,
      ).timeout(const Duration(seconds: 10));
      final data = jsonDecode(res.body) as Map<String, dynamic>;
      if (!mounted) return;
      if (res.statusCode == 200) {
        _snack(
          'Ride completed. Driver earnings: Rs ${((data['driverEarnings'] ?? 0) as num).toStringAsFixed(0)}',
        );
        await _loadRides();
      } else {
        _snack(data['message']?.toString() ?? 'Could not complete ride', error: true);
      }
    } catch (_) {
      _snack('Network error while completing ride', error: true);
    }
  }

  Future<void> _patchRide(String id, Map<String, dynamic> body) async {
    try {
      final headers = await AuthService.getHeaders();
      final res = await http.patch(
        Uri.parse(ApiConfig.driverOutstationPoolRide(id)),
        headers: {...headers, 'Content-Type': 'application/json'},
        body: jsonEncode(body),
      ).timeout(const Duration(seconds: 10));
      final data = jsonDecode(res.body) as Map<String, dynamic>;
      if (!mounted) return;
      if (res.statusCode == 200) {
        await _loadRides();
      } else {
        _snack(data['message']?.toString() ?? 'Update failed', error: true);
      }
    } catch (_) {
      _snack('Network error while updating ride', error: true);
    }
  }

  void _snack(String msg, {bool error = false}) {
    if (!mounted) return;
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(
        content: Text(msg),
        backgroundColor: error ? JT.error : JT.success,
        behavior: SnackBarBehavior.floating,
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: JT.bg,
      appBar: AppBar(
        backgroundColor: Colors.white,
        foregroundColor: JT.textPrimary,
        title: Text(
          'Outstation Pool',
          style: GoogleFonts.poppins(fontWeight: FontWeight.w600),
        ),
      ),
      body: RefreshIndicator(
        onRefresh: _loadRides,
        child: ListView(
          padding: const EdgeInsets.all(16),
          children: [
            _buildFormCard(),
            const SizedBox(height: 16),
            Text(
              'My Pool Rides',
              style: GoogleFonts.poppins(
                fontSize: 16,
                fontWeight: FontWeight.w600,
                color: JT.textPrimary,
              ),
            ),
            const SizedBox(height: 12),
            if (_loading)
              const Padding(
                padding: EdgeInsets.all(24),
                child: Center(child: CircularProgressIndicator(color: JT.primary)),
              )
            else if (_rides.isEmpty)
              _buildEmpty()
            else
              ..._rides.map(_buildRideCard),
          ],
        ),
      ),
    );
  }

  Widget _buildFormCard() {
    return Container(
      padding: const EdgeInsets.all(16),
      decoration: BoxDecoration(
        color: Colors.white,
        borderRadius: BorderRadius.circular(18),
        boxShadow: JT.cardShadow,
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(
            'Create New Ride',
            style: GoogleFonts.poppins(fontSize: 16, fontWeight: FontWeight.w600),
          ),
          const SizedBox(height: 12),
          _textField(_fromCtrl, 'From City'),
          const SizedBox(height: 10),
          _textField(_toCtrl, 'To City'),
          const SizedBox(height: 10),
          Row(
            children: [
              Expanded(child: _textField(_dateCtrl, 'Departure Date', readOnly: true, onTap: _pickDate)),
              const SizedBox(width: 10),
              Expanded(child: _textField(_timeCtrl, 'Departure Time', readOnly: true, onTap: _pickTime)),
            ],
          ),
          const SizedBox(height: 10),
          Row(
            children: [
              Expanded(child: _textField(_seatsCtrl, 'Seats', keyboardType: TextInputType.number)),
              const SizedBox(width: 10),
              Expanded(child: _textField(_fareCtrl, 'Fare / Seat', keyboardType: TextInputType.number)),
            ],
          ),
          const SizedBox(height: 10),
          Row(
            children: [
              Expanded(child: _textField(_routeKmCtrl, 'Route KM', keyboardType: TextInputType.number)),
              const SizedBox(width: 10),
              Expanded(child: _textField(_vehicleNumberCtrl, 'Vehicle Number')),
            ],
          ),
          const SizedBox(height: 10),
          _textField(_vehicleModelCtrl, 'Vehicle Model'),
          const SizedBox(height: 10),
          _textField(_noteCtrl, 'Note'),
          const SizedBox(height: 14),
          SizedBox(
            width: double.infinity,
            child: JT.gradientButton(
              label: 'Create Ride',
              loading: _creating,
              onTap: _createRide,
            ),
          ),
        ],
      ),
    );
  }

  Widget _textField(
    TextEditingController controller,
    String label, {
    TextInputType? keyboardType,
    bool readOnly = false,
    VoidCallback? onTap,
  }) {
    return TextField(
      controller: controller,
      keyboardType: keyboardType,
      readOnly: readOnly,
      onTap: onTap,
      decoration: InputDecoration(
        labelText: label,
        filled: true,
        fillColor: JT.bgSoft,
        border: OutlineInputBorder(
          borderRadius: BorderRadius.circular(12),
          borderSide: BorderSide.none,
        ),
      ),
    );
  }

  Widget _buildEmpty() {
    return Container(
      padding: const EdgeInsets.all(24),
      decoration: BoxDecoration(
        color: Colors.white,
        borderRadius: BorderRadius.circular(18),
        boxShadow: JT.cardShadow,
      ),
      child: Column(
        children: [
          const Icon(Icons.route_rounded, size: 44, color: JT.primary),
          const SizedBox(height: 10),
          Text(
            'No outstation pool rides yet',
            style: GoogleFonts.poppins(fontWeight: FontWeight.w600),
          ),
          const SizedBox(height: 6),
          Text(
            'Create a city-to-city ride and passengers can book seats.',
            textAlign: TextAlign.center,
            style: GoogleFonts.poppins(fontSize: 12, color: JT.textSecondary),
          ),
        ],
      ),
    );
  }

  Widget _buildRideCard(Map<String, dynamic> ride) {
    final from = ride['fromCity']?.toString() ?? ride['from_city']?.toString() ?? '';
    final to = ride['toCity']?.toString() ?? ride['to_city']?.toString() ?? '';
    final status = ride['status']?.toString() ?? 'scheduled';
    final totalSeats = ride['totalSeats'] ?? ride['total_seats'] ?? 0;
    final availableSeats = ride['availableSeats'] ?? ride['available_seats'] ?? 0;
    final fare = ((ride['farePerSeat'] ?? ride['fare_per_seat'] ?? 0) as num).toDouble();
    final bookings = ride['totalBookings'] ?? ride['total_bookings'] ?? 0;
    final active = ride['isActive'] == true || ride['is_active'] == true;

    return Container(
      margin: const EdgeInsets.only(bottom: 12),
      padding: const EdgeInsets.all(16),
      decoration: BoxDecoration(
        color: Colors.white,
        borderRadius: BorderRadius.circular(18),
        boxShadow: JT.cardShadow,
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Expanded(
                child: Text(
                  '$from -> $to',
                  style: GoogleFonts.poppins(fontSize: 15, fontWeight: FontWeight.w600),
                ),
              ),
              Container(
                padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 4),
                decoration: BoxDecoration(
                  color: active
                      ? const Color(0xFFE0F2FE)
                      : const Color(0xFFF1F5F9),
                  borderRadius: BorderRadius.circular(30),
                ),
                child: Text(
                  active ? 'Active' : 'Paused',
                  style: GoogleFonts.poppins(
                    fontSize: 11,
                    fontWeight: FontWeight.w600,
                    color: active ? const Color(0xFF0369A1) : JT.textSecondary,
                  ),
                ),
              ),
            ],
          ),
          const SizedBox(height: 10),
          Text(
            'Status: $status  |  Fare: Rs ${fare.toStringAsFixed(0)}/seat',
            style: GoogleFonts.poppins(fontSize: 12, color: JT.textSecondary),
          ),
          const SizedBox(height: 6),
          Text(
            'Seats: $availableSeats / $totalSeats available  |  Bookings: $bookings',
            style: GoogleFonts.poppins(fontSize: 12, color: JT.textSecondary),
          ),
          const SizedBox(height: 12),
          Row(
            children: [
              Expanded(
                child: OutlinedButton.icon(
                  onPressed: () => _showPassengerManifest(
                    ride['id']?.toString() ?? '',
                    (ride['totalBookings'] ?? ride['total_bookings'] ?? 0) as int,
                  ),
                  icon: const Icon(Icons.people_outline, size: 15),
                  label: Text('Passengers ($bookings)'),
                  style: OutlinedButton.styleFrom(
                    foregroundColor: JT.primary,
                    side: BorderSide(color: JT.primary.withValues(alpha: 0.4)),
                  ),
                ),
              ),
            ],
          ),
          const SizedBox(height: 8),
          if (status == 'scheduled' || status == 'active')
            Padding(
              padding: const EdgeInsets.only(bottom: 8),
              child: SizedBox(
                width: double.infinity,
                child: ElevatedButton.icon(
                  onPressed: status == 'active' ? null : () => _startRide(ride),
                  icon: const Icon(Icons.play_arrow_rounded, size: 18),
                  label: Text(status == 'active' ? 'Trip in progress' : 'Start Trip'),
                  style: ElevatedButton.styleFrom(
                    backgroundColor: JT.primary,
                    foregroundColor: Colors.white,
                    disabledBackgroundColor: JT.primary.withValues(alpha: 0.35),
                  ),
                ),
              ),
            ),
          Row(
            children: [
              Expanded(
                child: OutlinedButton(
                  onPressed: () => _toggleRide(ride),
                  child: Text(active ? 'Pause Ride' : 'Activate Ride'),
                ),
              ),
              const SizedBox(width: 10),
              Expanded(
                child: ElevatedButton(
                  onPressed: status == 'completed' ? null : () => _completeRide(ride),
                  style: ElevatedButton.styleFrom(backgroundColor: JT.primary),
                  child: const Text('Complete Ride', style: TextStyle(color: Colors.white)),
                ),
              ),
            ],
          ),
        ],
      ),
    );
  }
}
