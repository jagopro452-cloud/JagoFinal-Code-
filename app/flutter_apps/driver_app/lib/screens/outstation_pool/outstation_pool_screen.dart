import 'dart:convert';
import 'package:flutter/material.dart';
import 'package:google_fonts/google_fonts.dart';
import 'package:http/http.dart' as http;
import '../../config/api_config.dart';
import '../../services/auth_service.dart';
import 'outstation_pool_trip_screen.dart';
import 'post_outstation_ride_screen.dart';

class OutstationPoolScreen extends StatefulWidget {
  const OutstationPoolScreen({super.key});
  @override
  State<OutstationPoolScreen> createState() => _OutstationPoolScreenState();
}

class _OutstationPoolScreenState extends State<OutstationPoolScreen>
    with SingleTickerProviderStateMixin {
  List<dynamic> _rides = [];
  bool _loading = true;
  String? _error;
  late TabController _tabCtrl;

  static const _primary  = Color(0xFF2D8CFF);
  static const _bg       = Color(0xFFFFFFFF);
  static const _surface  = Color(0xFFF8FAFE);
  static const _border   = Color(0xFFE5E9F0);
  static const _textPri  = Color(0xFF111827);
  static const _textSec  = Color(0xFF6B7280);

  @override
  void initState() {
    super.initState();
    _tabCtrl = TabController(length: 2, vsync: this);
    _tabCtrl.addListener(() => setState(() {}));
    _load();
  }

  @override
  void dispose() {
    _tabCtrl.dispose();
    super.dispose();
  }

  Future<void> _load() async {
    setState(() { _loading = true; _error = null; });
    try {
      final token = await AuthService.getToken();
      final res = await http.get(
        Uri.parse('${ApiConfig.baseUrl}/api/app/driver/outstation-pool/rides'),
        headers: {'Authorization': 'Bearer $token'},
      ).timeout(const Duration(seconds: 12));
      if (res.statusCode == 200) {
        final data = jsonDecode(res.body);
        setState(() {
          _rides = List<dynamic>.from(data['rides'] ?? data ?? []);
          _loading = false;
        });
      } else {
        setState(() { _error = 'Failed to load rides'; _loading = false; });
      }
    } catch (e) {
      setState(() { _error = 'Network error. Check connection.'; _loading = false; });
    }
  }

  List<dynamic> get _active => _rides
      .where((r) => r['status'] == 'active' || r['status'] == 'scheduled')
      .toList();
  List<dynamic> get _past => _rides
      .where((r) => r['status'] == 'completed' || r['status'] == 'cancelled')
      .toList();

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: _bg,
      appBar: AppBar(
        backgroundColor: _bg,
        elevation: 0,
        surfaceTintColor: Colors.transparent,
        leading: IconButton(
          icon: const Icon(Icons.arrow_back_ios_new_rounded, size: 20, color: _textPri),
          onPressed: () => Navigator.pop(context),
        ),
        title: Text('Outstation Pool',
          style: GoogleFonts.poppins(fontSize: 17, fontWeight: FontWeight.w600, color: _textPri)),
        actions: [
          IconButton(
            icon: const Icon(Icons.refresh_rounded, color: _primary, size: 22),
            onPressed: _load,
          ),
          const SizedBox(width: 4),
        ],
        bottom: PreferredSize(
          preferredSize: const Size.fromHeight(44),
          child: Container(
            margin: const EdgeInsets.symmetric(horizontal: 16),
            height: 38,
            decoration: BoxDecoration(
              color: _surface,
              borderRadius: BorderRadius.circular(12),
              border: Border.all(color: _border),
            ),
            child: TabBar(
              controller: _tabCtrl,
              indicator: BoxDecoration(
                color: _primary,
                borderRadius: BorderRadius.circular(10),
              ),
              indicatorSize: TabBarIndicatorSize.tab,
              labelColor: Colors.white,
              unselectedLabelColor: _textSec,
              labelStyle: GoogleFonts.poppins(fontSize: 13, fontWeight: FontWeight.w600),
              unselectedLabelStyle: GoogleFonts.poppins(fontSize: 13, fontWeight: FontWeight.w400),
              dividerColor: Colors.transparent,
              tabs: [
                Tab(text: 'Active (${_active.length})'),
                Tab(text: 'Past (${_past.length})'),
              ],
            ),
          ),
        ),
      ),
      body: _loading
          ? const Center(child: CircularProgressIndicator(color: _primary, strokeWidth: 2.5))
          : _error != null
              ? _buildError()
              : TabBarView(
                  controller: _tabCtrl,
                  children: [
                    _buildList(_active, isActive: true),
                    _buildList(_past, isActive: false),
                  ],
                ),
      floatingActionButton: FloatingActionButton.extended(
        onPressed: () async {
          await Navigator.push(context,
            MaterialPageRoute(builder: (_) => const PostOutstationRideScreen()));
          _load();
        },
        backgroundColor: _primary,
        icon: const Icon(Icons.add_rounded, color: Colors.white),
        label: Text('Post Ride',
          style: GoogleFonts.poppins(color: Colors.white, fontWeight: FontWeight.w600, fontSize: 14)),
        elevation: 4,
      ),
    );
  }

  Widget _buildError() {
    return Center(
      child: Padding(
        padding: const EdgeInsets.all(32),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            const Icon(Icons.cloud_off_rounded, size: 48, color: _textSec),
            const SizedBox(height: 12),
            Text(_error!, textAlign: TextAlign.center,
              style: GoogleFonts.poppins(color: _textSec, fontSize: 14)),
            const SizedBox(height: 16),
            GestureDetector(
              onTap: _load,
              child: Container(
                padding: const EdgeInsets.symmetric(horizontal: 24, vertical: 12),
                decoration: BoxDecoration(
                  color: _primary,
                  borderRadius: BorderRadius.circular(12),
                ),
                child: Text('Retry',
                  style: GoogleFonts.poppins(color: Colors.white, fontWeight: FontWeight.w600)),
              ),
            ),
          ],
        ),
      ),
    );
  }

  Widget _buildList(List<dynamic> rides, {required bool isActive}) {
    if (rides.isEmpty) {
      return Center(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Icon(
              isActive ? Icons.directions_car_outlined : Icons.history_rounded,
              size: 52, color: _border,
            ),
            const SizedBox(height: 12),
            Text(
              isActive ? 'No active trips.\nTap + to post a new outstation ride.' : 'No past trips yet.',
              textAlign: TextAlign.center,
              style: GoogleFonts.poppins(color: _textSec, fontSize: 14),
            ),
          ],
        ),
      );
    }
    return RefreshIndicator(
      color: _primary,
      onRefresh: _load,
      child: ListView.builder(
        padding: const EdgeInsets.fromLTRB(16, 12, 16, 100),
        itemCount: rides.length,
        itemBuilder: (ctx, i) => _RideCard(
          ride: rides[i],
          isActive: isActive,
          onTap: () async {
            await Navigator.push(ctx,
              MaterialPageRoute(builder: (_) => OutstationPoolTripScreen(ride: rides[i])));
            _load();
          },
        ),
      ),
    );
  }
}

// ── Ride card ─────────────────────────────────────────────────────────────────

class _RideCard extends StatelessWidget {
  final Map<String, dynamic> ride;
  final bool isActive;
  final VoidCallback onTap;
  const _RideCard({required this.ride, required this.isActive, required this.onTap});

  static const _primary  = Color(0xFF2D8CFF);
  static const _card     = Color(0xFFFFFFFF);
  static const _border   = Color(0xFFE5E9F0);
  static const _green    = Color(0xFF16A34A);
  static const _amber    = Color(0xFFF59E0B);
  static const _red      = Color(0xFFDC2626);
  static const _textPri  = Color(0xFF111827);
  static const _textSec  = Color(0xFF6B7280);

  Color get _statusColor {
    switch (ride['status'] ?? '') {
      case 'active':     return _green;
      case 'scheduled':  return _primary;
      case 'completed':  return _green;
      case 'cancelled':  return _red;
      default:           return _amber;
    }
  }

  String get _statusLabel {
    switch (ride['status'] ?? '') {
      case 'active':    return 'Active';
      case 'scheduled': return 'Scheduled';
      case 'completed': return 'Completed';
      case 'cancelled': return 'Cancelled';
      default:          return (ride['status'] ?? '').toString().toUpperCase();
    }
  }

  @override
  Widget build(BuildContext context) {
    final availSeats   = ride['available_seats'] ?? 0;
    final totalSeats   = ride['total_seats'] ?? 4;
    final bookedSeats  = totalSeats - availSeats;
    final fromCity     = ride['from_city'] ?? '';
    final toCity       = ride['to_city'] ?? '';
    final routeKm      = (ride['route_km'] ?? 0.0) as num;
    final pkmps        = (ride['price_per_km_per_seat'] ?? 1.8) as num;
    final farePerSeat  = (ride['fare_per_seat'] ?? 0.0) as num;
    final depDate      = ride['departure_date'] ?? '';
    final depTime      = ride['departure_time'] ?? '';

    return GestureDetector(
      onTap: onTap,
      child: Container(
        margin: const EdgeInsets.only(bottom: 12),
        decoration: BoxDecoration(
          color: _card,
          borderRadius: BorderRadius.circular(16),
          border: Border.all(color: _statusColor.withValues(alpha: 0.18)),
          boxShadow: [
            BoxShadow(color: Colors.black.withValues(alpha: 0.05), blurRadius: 10, offset: const Offset(0, 3)),
          ],
        ),
        child: Padding(
          padding: const EdgeInsets.all(16),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              // Header: route + status badge
              Row(
                children: [
                  Container(
                    width: 44, height: 44,
                    decoration: BoxDecoration(
                      color: _primary.withValues(alpha: 0.10),
                      borderRadius: BorderRadius.circular(14),
                      border: Border.all(color: _primary.withValues(alpha: 0.22)),
                    ),
                    child: const Icon(Icons.route_rounded, color: _primary, size: 22),
                  ),
                  const SizedBox(width: 12),
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text('$fromCity  →  $toCity',
                          style: GoogleFonts.poppins(
                            fontSize: 15, fontWeight: FontWeight.w600, color: _textPri)),
                        const SizedBox(height: 2),
                        Text('${routeKm.toStringAsFixed(0)} km  ·  ₹${pkmps.toStringAsFixed(1)}/km/seat',
                          style: GoogleFonts.poppins(fontSize: 12, color: _textSec)),
                      ],
                    ),
                  ),
                  // Status badge
                  Container(
                    padding: const EdgeInsets.symmetric(horizontal: 9, vertical: 4),
                    decoration: BoxDecoration(
                      color: _statusColor.withValues(alpha: 0.10),
                      borderRadius: BorderRadius.circular(8),
                      border: Border.all(color: _statusColor.withValues(alpha: 0.25)),
                    ),
                    child: Text(_statusLabel,
                      style: GoogleFonts.poppins(
                        color: _statusColor, fontSize: 11, fontWeight: FontWeight.w600)),
                  ),
                ],
              ),
              const SizedBox(height: 14),
              // Divider
              Divider(color: _border, height: 1),
              const SizedBox(height: 12),
              // Stats row
              Row(
                children: [
                  _StatChip(
                    icon: Icons.event_seat_rounded,
                    label: '$bookedSeats/$totalSeats seats',
                    color: bookedSeats > 0 ? _green : _textSec,
                  ),
                  const SizedBox(width: 10),
                  _StatChip(
                    icon: Icons.currency_rupee_rounded,
                    label: '₹${farePerSeat.toStringAsFixed(0)}/seat',
                    color: _primary,
                  ),
                  const Spacer(),
                  if (depDate.isNotEmpty)
                    _StatChip(
                      icon: Icons.calendar_today_rounded,
                      label: depDate,
                      color: _textSec,
                    ),
                ],
              ),
              if (depTime.isNotEmpty) ...[
                const SizedBox(height: 8),
                Row(children: [
                  const Icon(Icons.schedule_rounded, size: 14, color: _textSec),
                  const SizedBox(width: 4),
                  Text('Departs at $depTime',
                    style: GoogleFonts.poppins(fontSize: 12, color: _textSec)),
                ]),
              ],
              if (isActive) ...[
                const SizedBox(height: 12),
                Row(children: [
                  const Spacer(),
                  Container(
                    padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 6),
                    decoration: BoxDecoration(
                      color: _primary.withValues(alpha: 0.10),
                      borderRadius: BorderRadius.circular(10),
                      border: Border.all(color: _primary.withValues(alpha: 0.25)),
                    ),
                    child: Row(children: [
                      const Icon(Icons.people_rounded, color: _primary, size: 15),
                      const SizedBox(width: 5),
                      Text('Manage Passengers',
                        style: GoogleFonts.poppins(
                          color: _primary, fontSize: 12, fontWeight: FontWeight.w600)),
                    ]),
                  ),
                ]),
              ],
            ],
          ),
        ),
      ),
    );
  }
}

class _StatChip extends StatelessWidget {
  final IconData icon;
  final String label;
  final Color color;
  const _StatChip({required this.icon, required this.label, required this.color});

  @override
  Widget build(BuildContext context) {
    return Row(
      mainAxisSize: MainAxisSize.min,
      children: [
        Icon(icon, size: 14, color: color),
        const SizedBox(width: 4),
        Text(label,
          style: GoogleFonts.poppins(fontSize: 12, color: color, fontWeight: FontWeight.w500)),
      ],
    );
  }
}
