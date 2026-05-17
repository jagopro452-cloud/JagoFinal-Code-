import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:google_fonts/google_fonts.dart';

import '../../config/jago_theme.dart';
import '../../services/auth_service.dart';
import '../main_screen.dart';
import 'register_screen.dart';

class LoginScreen extends StatefulWidget {
  const LoginScreen({super.key});

  @override
  State<LoginScreen> createState() => _LoginScreenState();
}

class _LoginScreenState extends State<LoginScreen> with TickerProviderStateMixin {
  final _phoneCtrl = TextEditingController();
  final _passwordCtrl = TextEditingController();
  bool _loading = false;
  bool _hidePassword = true;

  late final AnimationController _cardCtrl;
  late final Animation<Offset> _cardSlide;
  late final AnimationController _logoCtrl;
  late final Animation<double> _logoFade;

  @override
  void initState() {
    super.initState();
    _cardCtrl = AnimationController(vsync: this, duration: const Duration(milliseconds: 700));
    _cardSlide = Tween<Offset>(begin: const Offset(0, 1), end: Offset.zero)
        .animate(CurvedAnimation(parent: _cardCtrl, curve: Curves.easeOutCubic));
    _logoCtrl = AnimationController(vsync: this, duration: const Duration(milliseconds: 600));
    _logoFade = Tween<double>(begin: 0, end: 1)
        .animate(CurvedAnimation(parent: _logoCtrl, curve: Curves.easeOut));
    _logoCtrl.forward();
    Future.delayed(const Duration(milliseconds: 160), () {
      if (mounted) _cardCtrl.forward();
    });
  }

  @override
  void dispose() {
    _cardCtrl.dispose();
    _logoCtrl.dispose();
    _phoneCtrl.dispose();
    _passwordCtrl.dispose();
    super.dispose();
  }

  void _snack(String msg, {bool error = false}) {
    if (!mounted) return;
    ScaffoldMessenger.of(context).clearSnackBars();
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(
        content: Text(msg, style: GoogleFonts.poppins(color: Colors.white, fontSize: 13)),
        backgroundColor: error ? JT.error : JT.success,
        behavior: SnackBarBehavior.floating,
        margin: const EdgeInsets.fromLTRB(16, 0, 16, 16),
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12)),
      ),
    );
  }

  Future<void> _login() async {
    final phone = _phoneCtrl.text.trim();
    final password = _passwordCtrl.text;
    if (phone.length != 10) {
      _snack('Enter a valid 10-digit mobile number', error: true);
      return;
    }
    if (password.length < 8) {
      _snack('Password must be at least 8 characters', error: true);
      return;
    }
    setState(() => _loading = true);
    final res = await AuthService.loginWithPassword(phone, password);
    if (!mounted) return;
    setState(() => _loading = false);
    if (res['success'] == true || res['token'] != null) {
      Navigator.pushAndRemoveUntil(
        context,
        MaterialPageRoute(builder: (_) => const MainScreen()),
        (_) => false,
      );
      return;
    }
    _snack(res['message']?.toString() ?? 'Login failed. Please try again.', error: true);
  }

  @override
  Widget build(BuildContext context) {
    final size = MediaQuery.of(context).size;
    return AnnotatedRegion<SystemUiOverlayStyle>(
      value: const SystemUiOverlayStyle(statusBarColor: Colors.transparent, statusBarIconBrightness: Brightness.dark),
      child: Scaffold(
        backgroundColor: JT.bg,
        resizeToAvoidBottomInset: true,
        body: Stack(
          children: [
            Positioned.fill(child: Container(color: const Color(0xFFF7FAFF))),
            Positioned(
              top: 0,
              left: 0,
              right: 0,
              height: size.height * 0.42,
              child: FadeTransition(
                opacity: _logoFade,
                child: SafeArea(
                  child: Column(
                    mainAxisAlignment: MainAxisAlignment.center,
                    children: [
                      Container(
                        width: 76,
                        height: 76,
                        decoration: BoxDecoration(
                          borderRadius: BorderRadius.circular(24),
                          color: Colors.white,
                          border: Border.all(color: const Color(0xFFD8E6F8)),
                          boxShadow: [BoxShadow(color: JT.primary.withValues(alpha: 0.08), blurRadius: 20, offset: const Offset(0, 8))],
                        ),
                        child: Padding(padding: const EdgeInsets.all(10), child: JT.logoBlue(height: 44)),
                      ),
                      const SizedBox(height: 18),
                      JT.logoBlue(height: 36),
                      const SizedBox(height: 6),
                      Text('Secure password login', style: GoogleFonts.poppins(fontSize: 12, color: JT.textSecondary, letterSpacing: 0.5)),
                    ],
                  ),
                ),
              ),
            ),
            Positioned(
              bottom: 0,
              left: 0,
              right: 0,
              child: SlideTransition(
                position: _cardSlide,
                child: Container(
                  constraints: BoxConstraints(maxHeight: size.height * 0.64),
                  decoration: BoxDecoration(
                    color: Colors.white,
                    borderRadius: const BorderRadius.vertical(top: Radius.circular(32)),
                    boxShadow: [BoxShadow(color: Colors.black.withValues(alpha: 0.05), blurRadius: 24, offset: const Offset(0, -6))],
                  ),
                  child: SingleChildScrollView(
                    padding: EdgeInsets.fromLTRB(28, 20, 28, MediaQuery.of(context).viewInsets.bottom + 32),
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Center(child: Container(width: 36, height: 4, decoration: BoxDecoration(color: JT.border, borderRadius: BorderRadius.circular(2)))),
                        const SizedBox(height: 24),
                        Text('Sign In', style: GoogleFonts.poppins(fontSize: 26, fontWeight: FontWeight.w500, color: JT.textPrimary)),
                        const SizedBox(height: 4),
                        Text('Use mobile number and password. No OTP required.', style: GoogleFonts.poppins(fontSize: 13, color: JT.textSecondary)),
                        const SizedBox(height: 28),
                        _phoneField(),
                        const SizedBox(height: 16),
                        _passwordField(),
                        const SizedBox(height: 24),
                        _button('Login', _login),
                        const SizedBox(height: 24),
                        Row(
                          mainAxisAlignment: MainAxisAlignment.center,
                          children: [
                            Text('New here?  ', style: GoogleFonts.poppins(color: JT.textSecondary, fontSize: 14)),
                            GestureDetector(
                              onTap: () => Navigator.push(context, MaterialPageRoute(builder: (_) => const RegisterScreen())),
                              child: Text('Create Account', style: GoogleFonts.poppins(color: JT.primary, fontWeight: FontWeight.w500, fontSize: 14)),
                            ),
                          ],
                        ),
                      ],
                    ),
                  ),
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }

  Widget _phoneField() => TextField(
        controller: _phoneCtrl,
        keyboardType: TextInputType.phone,
        inputFormatters: [FilteringTextInputFormatter.digitsOnly, LengthLimitingTextInputFormatter(10)],
        decoration: _decoration('Mobile number', Icons.phone_iphone_rounded, prefixText: '+91 '),
      );

  Widget _passwordField() => TextField(
        controller: _passwordCtrl,
        obscureText: _hidePassword,
        textInputAction: TextInputAction.done,
        onSubmitted: (_) => _login(),
        decoration: _decoration('Password', Icons.lock_outline_rounded).copyWith(
          suffixIcon: IconButton(
            icon: Icon(_hidePassword ? Icons.visibility_off_outlined : Icons.visibility_outlined),
            onPressed: () => setState(() => _hidePassword = !_hidePassword),
          ),
        ),
      );

  InputDecoration _decoration(String hint, IconData icon, {String? prefixText}) => InputDecoration(
        hintText: hint,
        prefixText: prefixText,
        prefixIcon: Icon(icon, color: JT.primary, size: 20),
        filled: true,
        fillColor: const Color(0xFFF8FAFC),
        border: OutlineInputBorder(borderRadius: BorderRadius.circular(16), borderSide: const BorderSide(color: Color(0xFFE2E8F0))),
        enabledBorder: OutlineInputBorder(borderRadius: BorderRadius.circular(16), borderSide: const BorderSide(color: Color(0xFFE2E8F0))),
        focusedBorder: OutlineInputBorder(borderRadius: BorderRadius.circular(16), borderSide: const BorderSide(color: JT.primary, width: 1.4)),
      );

  Widget _button(String label, VoidCallback onTap) => SizedBox(
        width: double.infinity,
        height: 56,
        child: ElevatedButton(
          onPressed: _loading ? null : onTap,
          style: ElevatedButton.styleFrom(backgroundColor: JT.primary, foregroundColor: Colors.white, shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(18)), elevation: 0),
          child: _loading
              ? const SizedBox(width: 24, height: 24, child: CircularProgressIndicator(color: Colors.white, strokeWidth: 2.5))
              : Text(label, style: GoogleFonts.poppins(fontSize: 16, fontWeight: FontWeight.w500)),
        ),
      );
}
