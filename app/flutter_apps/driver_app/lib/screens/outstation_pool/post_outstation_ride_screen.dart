import 'dart:convert';
import 'package:flutter/material.dart';
import 'package:google_fonts/google_fonts.dart';
import 'package:http/http.dart' as http;
import '../../config/api_config.dart';
import '../../services/auth_service.dart';

class PostOutstationRideScreen extends StatefulWidget {
  const PostOutstationRideScreen({super.key});
  @override
  State<PostOutstationRideScreen> createState() => _PostOutstationRideScreenState();
}

class _PostOutstationRideScreenState extends State<PostOutstationRideScreen> {
  final _formKey = GlobalKey<FormState>();
  final _fromCtrl       = TextEditingController();
  final _toCtrl         = TextEditingController();
  final _fromLatCtrl    = TextEditingController();
  final _fromLngCtrl    = TextEditingController();
  final _toLatCtrl      = TextEditingController();
  final _toLngCtrl      = TextEditingController();
  final _priceCtrl      = TextEditingController(text: '1.8');
  final _seatsCtrl      = TextEditingController(text: '4');
  final _vehicleNoCtrl  = TextEditingController();
  final _vehicleModel   = TextEditingController();
  final _noteCtrl       = TextEditingController();
  DateTime? _depDate;
  TimeOfDay? _depTime;
  bool _loading = false;
  Map<String, dynamic>? _result;

  static const _primary  = Color(0xFF2D8CFF);
  static const _bg       = Color(0xFFFFFFFF);
  static const _border   = Color(0xFFE5E9F0);
  static const _green    = Color(0xFF16A34A);
  static const _red      = Color(0xFFDC2626);
  static const _textPri  = Color(0xFF111827);
  static const _textSec  = Color(0xFF6B7280);

  @override
  void dispose() {
    for (final c in [_fromCtrl, _toCtrl, _fromLatCtrl, _fromLngCtrl,
      _toLatCtrl, _toLngCtrl, _priceCtrl, _seatsCtrl,
      _vehicleNoCtrl, _vehicleModel, _noteCtrl]) {
      c.dispose();
    }
    super.dispose();
  }

  Future<void> _submit() async {
    if (!(_formKey.currentState?.validate() ?? false)) return;
    setState(() => _loading = true);
    try {
      final token = await AuthService.getToken();
      final depDateStr = _depDate != null
          ? '${_depDate!.year}-${_depDate!.month.toString().padLeft(2,'0')}-${_depDate!.day.toString().padLeft(2,'0')}'
          : null;
      final depTimeStr = _depTime != null
          ? '${_depTime!.hour.toString().padLeft(2,'0')}:${_depTime!.minute.toString().padLeft(2,'0')}'
          : null;

      final body = {
        'fromCity':           _fromCtrl.text.trim(),
        'toCity':             _toCtrl.text.trim(),
        'fromLat':            _fromLatCtrl.text.trim(),
        'fromLng':            _fromLngCtrl.text.trim(),
        'toLat':              _toLatCtrl.text.trim(),
        'toLng':              _toLngCtrl.text.trim(),
        'pricePerKmPerSeat':  double.tryParse(_priceCtrl.text) ?? 1.8,
        'totalSeats':         int.tryParse(_seatsCtrl.text) ?? 4,
        'vehicleNumber':      _vehicleNoCtrl.text.trim().isEmpty ? null : _vehicleNoCtrl.text.trim(),
        'vehicleModel':       _vehicleModel.text.trim().isEmpty  ? null : _vehicleModel.text.trim(),
        'note':               _noteCtrl.text.trim().isEmpty       ? null : _noteCtrl.text.trim(),
        if (depDateStr != null) 'departureDate': depDateStr,
        if (depTimeStr != null) 'departureTime': depTimeStr,
      };
      body.removeWhere((k, v) => v == null);

      final res = await http.post(
        Uri.parse('${ApiConfig.baseUrl}/api/app/driver/outstation-pool/v2/rides'),
        headers: {
          'Authorization': 'Bearer $token',
          'Content-Type': 'application/json',
        },
        body: jsonEncode(body),
      ).timeout(const Duration(seconds: 15));

      if (res.statusCode == 200 || res.statusCode == 201) {
        final data = jsonDecode(res.body);
        setState(() { _result = data; _loading = false; });
      } else {
        final msg = jsonDecode(res.body)['message'] ?? 'Failed to post ride';
        _showSnack(msg, isError: true);
        setState(() => _loading = false);
      }
    } catch (e) {
      _showSnack('Error: $e', isError: true);
      setState(() => _loading = false);
    }
  }

  void _showSnack(String msg, {bool isError = false}) {
    if (!mounted) return;
    ScaffoldMessenger.of(context).showSnackBar(SnackBar(
      content: Text(msg, style: GoogleFonts.poppins(color: Colors.white, fontSize: 13)),
      backgroundColor: isError ? _red : _green,
      behavior: SnackBarBehavior.floating,
      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12)),
      margin: const EdgeInsets.all(16),
    ));
  }

  @override
  Widget build(BuildContext context) {
    if (_result != null) return _buildSuccess();

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
        title: Text('Post Outstation Ride',
          style: GoogleFonts.poppins(fontSize: 16, fontWeight: FontWeight.w600, color: _textPri)),
      ),
      body: Form(
        key: _formKey,
        child: ListView(
          padding: const EdgeInsets.fromLTRB(16, 8, 16, 100),
          children: [
            // Route section
            _SectionHeader('Route'),
            _FieldRow([
              _Field(_fromCtrl, 'From City', hint: 'e.g. Vijayawada', required: true),
              _Field(_toCtrl,   'To City',   hint: 'e.g. Hyderabad',  required: true),
            ]),
            const SizedBox(height: 12),
            _SectionHeader('From Coordinates', sub: 'Tap map or enter manually'),
            _FieldRow([
              _Field(_fromLatCtrl, 'From Lat', hint: '16.5062', keyboard: TextInputType.number),
              _Field(_fromLngCtrl, 'From Lng', hint: '80.6480', keyboard: TextInputType.number),
            ]),
            const SizedBox(height: 8),
            _FieldRow([
              _Field(_toLatCtrl, 'To Lat', hint: '17.3850', keyboard: TextInputType.number),
              _Field(_toLngCtrl, 'To Lng', hint: '78.4867', keyboard: TextInputType.number),
            ]),
            const SizedBox(height: 12),
            // Pricing
            _SectionHeader('Pricing'),
            Container(
              padding: const EdgeInsets.all(14),
              decoration: BoxDecoration(
                color: const Color(0xFFF3F7FF),
                borderRadius: BorderRadius.circular(14),
                border: Border.all(color: _primary.withValues(alpha: 0.18)),
              ),
              child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                Text('₹ per km per seat',
                  style: GoogleFonts.poppins(fontSize: 13, fontWeight: FontWeight.w600, color: _textPri)),
                const SizedBox(height: 4),
                Text('Each passenger pays: distance × price × seats booked\nExample: 300 km × ₹1.8 × 2 seats = ₹1,080',
                  style: GoogleFonts.poppins(fontSize: 11, color: _textSec)),
                const SizedBox(height: 10),
                _Field(_priceCtrl, 'Price per km per seat (₹)',
                  hint: '1.8', keyboard: TextInputType.number, required: true,
                  validator: (v) {
                    final n = double.tryParse(v ?? '');
                    if (n == null || n < 0.5) return 'Min ₹0.5/km/seat';
                    if (n > 50) return 'Max ₹50/km/seat';
                    return null;
                  },
                ),
              ]),
            ),
            const SizedBox(height: 12),
            _FieldRow([
              _Field(_seatsCtrl, 'Total seats',
                hint: '4', keyboard: TextInputType.number, required: true,
                validator: (v) {
                  final n = int.tryParse(v ?? '');
                  if (n == null || n < 1 || n > 8) return '1–8 seats';
                  return null;
                }),
            ]),
            const SizedBox(height: 12),
            // Schedule
            _SectionHeader('Departure (optional)'),
            Row(children: [
              Expanded(
                child: _DatePickerTile(
                  label: _depDate == null
                      ? 'Pick date'
                      : '${_depDate!.day}/${_depDate!.month}/${_depDate!.year}',
                  icon: Icons.calendar_today_rounded,
                  onTap: () async {
                    final d = await showDatePicker(
                      context: context,
                      initialDate: DateTime.now(),
                      firstDate: DateTime.now(),
                      lastDate: DateTime.now().add(const Duration(days: 30)),
                    );
                    if (d != null) setState(() => _depDate = d);
                  },
                ),
              ),
              const SizedBox(width: 12),
              Expanded(
                child: _DatePickerTile(
                  label: _depTime == null
                      ? 'Pick time'
                      : _depTime!.format(context),
                  icon: Icons.schedule_rounded,
                  onTap: () async {
                    final t = await showTimePicker(
                      context: context,
                      initialTime: TimeOfDay.now(),
                    );
                    if (t != null) setState(() => _depTime = t);
                  },
                ),
              ),
            ]),
            const SizedBox(height: 12),
            // Vehicle info
            _SectionHeader('Vehicle (optional)'),
            _FieldRow([
              _Field(_vehicleNoCtrl, 'Vehicle No', hint: 'AP16AB1234'),
              _Field(_vehicleModel,  'Vehicle Model', hint: 'Swift Dzire'),
            ]),
            const SizedBox(height: 12),
            _Field(_noteCtrl, 'Note for passengers', hint: 'E.g. AC car, music allowed', maxLines: 2),
            const SizedBox(height: 20),
          ],
        ),
      ),
      bottomNavigationBar: SafeArea(
        child: Padding(
          padding: const EdgeInsets.fromLTRB(16, 8, 16, 12),
          child: GestureDetector(
            onTap: _loading ? null : _submit,
            child: Container(
              height: 54,
              decoration: BoxDecoration(
                color: _primary,
                borderRadius: BorderRadius.circular(16),
                boxShadow: [BoxShadow(
                  color: _primary.withValues(alpha: 0.28), blurRadius: 14, offset: const Offset(0, 5))],
              ),
              child: Center(
                child: _loading
                    ? const SizedBox(width: 24, height: 24,
                        child: CircularProgressIndicator(color: Colors.white, strokeWidth: 2.5))
                    : Row(mainAxisSize: MainAxisSize.min, children: [
                        const Icon(Icons.check_rounded, color: Colors.white, size: 22),
                        const SizedBox(width: 8),
                        Text('Post Ride',
                          style: GoogleFonts.poppins(
                            color: Colors.white, fontWeight: FontWeight.w700, fontSize: 16)),
                      ]),
              ),
            ),
          ),
        ),
      ),
    );
  }

  Widget _buildSuccess() {
    final info     = _result!['info'] as Map<String, dynamic>? ?? {};
    final routeKm  = info['routeKm'] ?? 0;
    final pkmps    = info['pricePerKmPerSeat'] ?? 1.8;
    final example  = info['example'] ?? '';
    return Scaffold(
      backgroundColor: _bg,
      body: SafeArea(
        child: Padding(
          padding: const EdgeInsets.all(24),
          child: Column(
            mainAxisAlignment: MainAxisAlignment.center,
            children: [
              Container(
                width: 80, height: 80,
                decoration: BoxDecoration(
                  color: _green.withValues(alpha: 0.12),
                  shape: BoxShape.circle,
                  border: Border.all(color: _green.withValues(alpha: 0.3), width: 2),
                ),
                child: const Icon(Icons.check_rounded, color: _green, size: 42),
              ),
              const SizedBox(height: 20),
              Text('Ride Posted!',
                style: GoogleFonts.poppins(fontSize: 22, fontWeight: FontWeight.w700, color: _textPri)),
              const SizedBox(height: 8),
              Text('${_fromCtrl.text}  →  ${_toCtrl.text}',
                style: GoogleFonts.poppins(fontSize: 15, color: _textSec)),
              const SizedBox(height: 24),
              Container(
                padding: const EdgeInsets.all(16),
                decoration: BoxDecoration(
                  color: const Color(0xFFF3F7FF),
                  borderRadius: BorderRadius.circular(16),
                  border: Border.all(color: _border),
                ),
                child: Column(children: [
                  _ResultRow('Route distance', '${routeKm} km'),
                  _ResultRow('Price per km/seat', '₹${pkmps}'),
                  if (example.isNotEmpty) _ResultRow('Example fare', example),
                  _ResultRow('Seats available', _seatsCtrl.text),
                ]),
              ),
              const SizedBox(height: 8),
              Text('Commission 15% + GST + insurance\nwill be deducted per passenger at drop.',
                textAlign: TextAlign.center,
                style: GoogleFonts.poppins(fontSize: 11, color: _textSec)),
              const SizedBox(height: 28),
              GestureDetector(
                onTap: () => Navigator.pop(context),
                child: Container(
                  height: 52,
                  decoration: BoxDecoration(
                    color: _primary,
                    borderRadius: BorderRadius.circular(14),
                    boxShadow: [BoxShadow(
                      color: _primary.withValues(alpha: 0.25), blurRadius: 12, offset: const Offset(0, 4))],
                  ),
                  child: Center(
                    child: Text('View My Trips',
                      style: GoogleFonts.poppins(
                        color: Colors.white, fontWeight: FontWeight.w700, fontSize: 15))),
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

// ── Small helpers ─────────────────────────────────────────────────────────────

class _SectionHeader extends StatelessWidget {
  final String text;
  final String? sub;
  const _SectionHeader(this.text, {this.sub});

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.only(bottom: 8),
      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Text(text,
          style: GoogleFonts.poppins(
            fontSize: 13, fontWeight: FontWeight.w700,
            color: const Color(0xFF111827))),
        if (sub != null)
          Text(sub!,
            style: GoogleFonts.poppins(fontSize: 11, color: const Color(0xFF6B7280))),
      ]),
    );
  }
}

class _FieldRow extends StatelessWidget {
  final List<Widget> children;
  const _FieldRow(this.children);
  @override
  Widget build(BuildContext context) {
    if (children.length == 1) return children[0];
    return Row(
      children: children.expand((w) sync* {
        yield Expanded(child: w);
        if (w != children.last) yield const SizedBox(width: 12);
      }).toList(),
    );
  }
}

class _Field extends StatelessWidget {
  final TextEditingController ctrl;
  final String label;
  final String? hint;
  final TextInputType? keyboard;
  final bool required;
  final int maxLines;
  final String? Function(String?)? validator;

  const _Field(this.ctrl, this.label, {
    this.hint, this.keyboard, this.required = false,
    this.maxLines = 1, this.validator,
  });

  @override
  Widget build(BuildContext context) {
    return TextFormField(
      controller: ctrl,
      keyboardType: keyboard,
      maxLines: maxLines,
      style: GoogleFonts.poppins(fontSize: 13, color: const Color(0xFF111827)),
      decoration: InputDecoration(
        labelText: label,
        hintText: hint,
        labelStyle: GoogleFonts.poppins(fontSize: 12, color: const Color(0xFF6B7280)),
        hintStyle: GoogleFonts.poppins(fontSize: 12, color: const Color(0xFFBCC3CF)),
        filled: true,
        fillColor: const Color(0xFFF8FAFE),
        border: OutlineInputBorder(
          borderRadius: BorderRadius.circular(12),
          borderSide: const BorderSide(color: Color(0xFFE5E9F0)),
        ),
        enabledBorder: OutlineInputBorder(
          borderRadius: BorderRadius.circular(12),
          borderSide: const BorderSide(color: Color(0xFFE5E9F0)),
        ),
        focusedBorder: OutlineInputBorder(
          borderRadius: BorderRadius.circular(12),
          borderSide: const BorderSide(color: Color(0xFF2D8CFF), width: 1.5),
        ),
        errorBorder: OutlineInputBorder(
          borderRadius: BorderRadius.circular(12),
          borderSide: const BorderSide(color: Color(0xFFDC2626)),
        ),
        contentPadding: const EdgeInsets.symmetric(horizontal: 12, vertical: 12),
        isDense: true,
      ),
      validator: validator ??
          (required
              ? (v) => (v == null || v.trim().isEmpty) ? 'Required' : null
              : null),
    );
  }
}

class _DatePickerTile extends StatelessWidget {
  final String label;
  final IconData icon;
  final VoidCallback onTap;
  const _DatePickerTile({required this.label, required this.icon, required this.onTap});

  @override
  Widget build(BuildContext context) {
    return GestureDetector(
      onTap: onTap,
      child: Container(
        height: 48,
        padding: const EdgeInsets.symmetric(horizontal: 12),
        decoration: BoxDecoration(
          color: const Color(0xFFF8FAFE),
          borderRadius: BorderRadius.circular(12),
          border: Border.all(color: const Color(0xFFE5E9F0)),
        ),
        child: Row(children: [
          Icon(icon, size: 16, color: const Color(0xFF2D8CFF)),
          const SizedBox(width: 8),
          Expanded(
            child: Text(label,
              style: GoogleFonts.poppins(
                fontSize: 12,
                color: label.contains('Pick') ? const Color(0xFFBCC3CF) : const Color(0xFF111827),
              )),
          ),
        ]),
      ),
    );
  }
}

class _ResultRow extends StatelessWidget {
  final String label;
  final String value;
  const _ResultRow(this.label, this.value);

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 3),
      child: Row(
        mainAxisAlignment: MainAxisAlignment.spaceBetween,
        children: [
          Text(label, style: GoogleFonts.poppins(fontSize: 12, color: const Color(0xFF6B7280))),
          Text(value, style: GoogleFonts.poppins(
            fontSize: 13, fontWeight: FontWeight.w600, color: const Color(0xFF111827))),
        ],
      ),
    );
  }
}
