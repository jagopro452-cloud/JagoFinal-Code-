import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:google_fonts/google_fonts.dart';

import '../../config/jago_theme.dart';
import '../../services/auth_service.dart';
import '../main_screen.dart';

class RegisterScreen extends StatefulWidget {
  const RegisterScreen({super.key});

  @override
  State<RegisterScreen> createState() => _RegisterScreenState();
}

class _RegisterScreenState extends State<RegisterScreen> {
  final _nameCtrl = TextEditingController();
  final _phoneCtrl = TextEditingController();
  final _emailCtrl = TextEditingController();
  final _passwordCtrl = TextEditingController();
  final _confirmCtrl = TextEditingController();
  bool _loading = false;
  bool _hidePassword = true;

  static const Color _blue = Color(0xFF2F7BFF);
  static const Color _navy = JT.textPrimary;

  @override
  void dispose() {
    _nameCtrl.dispose();
    _phoneCtrl.dispose();
    _emailCtrl.dispose();
    _passwordCtrl.dispose();
    _confirmCtrl.dispose();
    super.dispose();
  }

  void _showSnack(String msg, {bool error = false}) {
    if (!mounted) return;
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(
        content: Text(msg, style: GoogleFonts.poppins(color: Colors.white, fontSize: 13)),
        backgroundColor: error ? const Color(0xFFEF4444) : _blue,
        behavior: SnackBarBehavior.floating,
        margin: const EdgeInsets.fromLTRB(16, 0, 16, 16),
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12)),
      ),
    );
  }

  Future<void> _createAccount() async {
    final name = _nameCtrl.text.trim();
    final phone = _phoneCtrl.text.trim();
    final email = _emailCtrl.text.trim();
    final password = _passwordCtrl.text;
    final confirm = _confirmCtrl.text;
    if (name.length < 2) {
      _showSnack('Please enter your full name', error: true);
      return;
    }
    if (phone.length != 10) {
      _showSnack('Enter a valid 10-digit phone number', error: true);
      return;
    }
    if (password.length < 8) {
      _showSnack('Password must be at least 8 characters', error: true);
      return;
    }
    if (password != confirm) {
      _showSnack('Passwords do not match', error: true);
      return;
    }

    setState(() => _loading = true);
    final res = await AuthService.registerWithPassword(
      phone,
      password,
      name,
      email: email.isEmpty ? null : email,
    );
    if (!mounted) return;
    setState(() => _loading = false);
    if (res['success'] == true || res['token'] != null) {
      Navigator.pushAndRemoveUntil(
        context,
        PageRouteBuilder(
          pageBuilder: (_, __, ___) => const MainScreen(),
          transitionDuration: const Duration(milliseconds: 400),
          transitionsBuilder: (_, anim, __, child) => FadeTransition(opacity: anim, child: child),
        ),
        (_) => false,
      );
      return;
    }
    _showSnack(res['message']?.toString() ?? 'Registration failed. Please try again.', error: true);
  }

  @override
  Widget build(BuildContext context) {
    return AnnotatedRegion<SystemUiOverlayStyle>(
      value: SystemUiOverlayStyle.dark,
      child: Scaffold(
        backgroundColor: Colors.white,
        appBar: AppBar(
          backgroundColor: Colors.white,
          elevation: 0,
          scrolledUnderElevation: 0,
          leading: IconButton(
            icon: const Icon(Icons.arrow_back_ios_new_rounded, color: JT.textPrimary, size: 20),
            onPressed: () => Navigator.pop(context),
          ),
          title: Text('Create Account', style: GoogleFonts.poppins(color: _navy, fontWeight: FontWeight.w500, fontSize: 17)),
          centerTitle: true,
        ),
        body: SingleChildScrollView(
          padding: const EdgeInsets.fromLTRB(24, 8, 24, 40),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              const SizedBox(height: 4),
              Text('Join Jago Today', style: GoogleFonts.poppins(fontSize: 26, fontWeight: FontWeight.w500, color: _navy)),
              const SizedBox(height: 4),
              Text('Create a secure password account. No OTP required.', style: GoogleFonts.poppins(fontSize: 13, color: const Color(0xFF94A3B8))),
              const SizedBox(height: 28),
              _label('Full Name'),
              const SizedBox(height: 8),
              _input(_nameCtrl, 'Enter your full name', Icons.person_outline_rounded, textCap: TextCapitalization.words),
              const SizedBox(height: 16),
              _label('Phone Number'),
              const SizedBox(height: 8),
              _phoneInput(),
              const SizedBox(height: 16),
              _label('Email (Optional)'),
              const SizedBox(height: 8),
              _input(_emailCtrl, 'your@email.com', Icons.mail_outline_rounded, keyboard: TextInputType.emailAddress),
              const SizedBox(height: 16),
              _label('Password'),
              const SizedBox(height: 8),
              _passwordInput(_passwordCtrl, 'Minimum 8 characters'),
              const SizedBox(height: 16),
              _label('Confirm Password'),
              const SizedBox(height: 8),
              _passwordInput(_confirmCtrl, 'Re-enter password'),
              const SizedBox(height: 32),
              SizedBox(
                width: double.infinity,
                height: 58,
                child: DecoratedBox(
                  decoration: BoxDecoration(
                    gradient: _loading ? null : const LinearGradient(colors: [Color(0xFF56CCF2), Color(0xFF1A6FE0)], begin: Alignment.centerLeft, end: Alignment.centerRight),
                    color: _loading ? _blue.withValues(alpha: 0.4) : null,
                    borderRadius: BorderRadius.circular(18),
                    boxShadow: _loading ? [] : [BoxShadow(color: _blue.withValues(alpha: 0.4), blurRadius: 20, offset: const Offset(0, 8))],
                  ),
                  child: ElevatedButton(
                    onPressed: _loading ? null : _createAccount,
                    style: ElevatedButton.styleFrom(backgroundColor: Colors.transparent, shadowColor: Colors.transparent, disabledBackgroundColor: Colors.transparent, shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(18)), elevation: 0),
                    child: _loading
                        ? const SizedBox(width: 24, height: 24, child: CircularProgressIndicator(color: Colors.white, strokeWidth: 2.5))
                        : Text('Create Account', style: GoogleFonts.poppins(fontSize: 17, fontWeight: FontWeight.w500, color: Colors.white)),
                  ),
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }

  Widget _label(String label) => Text(label, style: GoogleFonts.poppins(fontSize: 13, fontWeight: FontWeight.w500, color: _navy));

  Widget _phoneInput() => _input(
        _phoneCtrl,
        'Enter 10-digit number',
        Icons.phone_iphone_rounded,
        keyboard: TextInputType.phone,
        prefixText: '+91 ',
        formatters: [FilteringTextInputFormatter.digitsOnly, LengthLimitingTextInputFormatter(10)],
      );

  Widget _passwordInput(TextEditingController controller, String hint) => _input(
        controller,
        hint,
        Icons.lock_outline_rounded,
        obscure: _hidePassword,
        suffix: IconButton(
          icon: Icon(_hidePassword ? Icons.visibility_off_outlined : Icons.visibility_outlined),
          onPressed: () => setState(() => _hidePassword = !_hidePassword),
        ),
      );

  Widget _input(
    TextEditingController controller,
    String hint,
    IconData icon, {
    TextInputType keyboard = TextInputType.text,
    TextCapitalization textCap = TextCapitalization.none,
    List<TextInputFormatter>? formatters,
    bool obscure = false,
    Widget? suffix,
    String? prefixText,
  }) {
    return TextField(
      controller: controller,
      keyboardType: keyboard,
      textCapitalization: textCap,
      inputFormatters: formatters,
      obscureText: obscure,
      style: GoogleFonts.poppins(fontSize: 15, color: _navy),
      decoration: InputDecoration(
        hintText: hint,
        prefixText: prefixText,
        prefixIcon: Icon(icon, color: JT.primary, size: 20),
        suffixIcon: suffix,
        filled: true,
        fillColor: const Color(0xFFF8FAFC),
        border: OutlineInputBorder(borderRadius: BorderRadius.circular(16), borderSide: const BorderSide(color: Color(0xFFE2E8F0))),
        enabledBorder: OutlineInputBorder(borderRadius: BorderRadius.circular(16), borderSide: const BorderSide(color: Color(0xFFE2E8F0))),
        focusedBorder: OutlineInputBorder(borderRadius: BorderRadius.circular(16), borderSide: const BorderSide(color: JT.primary, width: 1.4)),
      ),
    );
  }
}
