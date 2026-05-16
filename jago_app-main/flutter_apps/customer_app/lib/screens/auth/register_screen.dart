import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:google_fonts/google_fonts.dart';

import '../../config/jago_theme.dart';
import '../../services/auth_service.dart';
import '../../services/firebase_otp_service.dart';
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
  final _otpCtrl = TextEditingController();

  bool _loading = false;
  bool _otpSent = false;
  int _seconds = 0;
  Timer? _timer;
  String? _firebaseVerificationId;

  static const Color _blue = Color(0xFF2F7BFF);
  static const Color _navy = JT.textPrimary;

  @override
  void dispose() {
    _timer?.cancel();
    FirebaseOtpService.resetVerification();
    _nameCtrl.dispose();
    _phoneCtrl.dispose();
    _emailCtrl.dispose();
    _otpCtrl.dispose();
    super.dispose();
  }

  void _showSnack(String msg, {bool error = false}) {
    if (!mounted) return;
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(
        content: Text(msg, style: GoogleFonts.poppins(fontWeight: FontWeight.w400, color: Colors.white, fontSize: 13)),
        backgroundColor: error ? const Color(0xFFEF4444) : _blue,
        behavior: SnackBarBehavior.floating,
        margin: const EdgeInsets.fromLTRB(16, 0, 16, 16),
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12)),
        duration: const Duration(seconds: 3),
      ),
    );
  }

  void _startTimer() {
    _timer?.cancel();
    _seconds = 60;
    _timer = Timer.periodic(const Duration(seconds: 1), (t) {
      if (!mounted || _seconds == 0) {
        t.cancel();
        return;
      }
      setState(() => _seconds--);
    });
  }

  Future<void> _sendOtp() async {
    final name = _nameCtrl.text.trim();
    final phone = _phoneCtrl.text.trim();
    if (name.length < 2) {
      _showSnack("Please enter your full name", error: true);
      return;
    }
    if (phone.length != 10) {
      _showSnack("Enter a valid 10-digit phone number", error: true);
      return;
    }

    setState(() => _loading = true);
    _firebaseVerificationId = null;
    await FirebaseOtpService.resetVerification();

    bool firebaseSent = false;
    String? firebaseError;
    await FirebaseOtpService.sendOtp(
      phoneNumber: "+91$phone",
      onCodeSent: (verificationId) {
        _firebaseVerificationId = verificationId;
        firebaseSent = true;
      },
      onError: (error) {
        firebaseError = error;
      },
    );

    if (!mounted) return;

    if (!firebaseSent) {
      await FirebaseOtpService.sendOtp(
        phoneNumber: "+91$phone",
        forceResend: true,
        onCodeSent: (verificationId) {
          _firebaseVerificationId = verificationId;
          firebaseSent = true;
        },
        onError: (error) {
          firebaseError = error;
        },
      );
    }

    if (!mounted) return;

    if (firebaseSent) {
      setState(() {
        _otpSent = true;
        _loading = false;
      });
      _startTimer();
      _showSnack("OTP sent to +91$phone");
      return;
    }

    setState(() => _loading = false);
    _showSnack(firebaseError ?? "Failed to send OTP", error: true);
  }

  Future<void> _verifyAndCreateAccount() async {
    final phone = _phoneCtrl.text.trim();
    final otp = _otpCtrl.text.trim();
    final name = _nameCtrl.text.trim();
    if (otp.length != 6) {
      _showSnack("Enter the 6-digit OTP", error: true);
      return;
    }
    if (_firebaseVerificationId == null) {
      _showSnack("OTP session expired. Please resend OTP.", error: true);
      return;
    }

    setState(() => _loading = true);
    try {
      final idToken = await FirebaseOtpService.verifyOtp(
        smsCode: otp,
        verificationId: _firebaseVerificationId,
      );
      if (!mounted) return;
      final authRes = await AuthService.verifyFirebaseToken(idToken, phone, "customer");
      if (!mounted) return;
      if (!(authRes["success"] == true || authRes["token"] != null)) {
        throw Exception(authRes["message"] ?? "Account verification failed.");
      }

      final updateRes = await AuthService.updateProfile(
        fullName: name,
        email: _emailCtrl.text.trim().isEmpty ? null : _emailCtrl.text.trim(),
      );
      if (!mounted) return;
      if (updateRes["success"] == false) {
        throw Exception(updateRes["message"] ?? "Account created, but profile update failed.");
      }

      Navigator.pushAndRemoveUntil(
        context,
        PageRouteBuilder(
          pageBuilder: (_, __, ___) => const MainScreen(),
          transitionDuration: const Duration(milliseconds: 400),
          transitionsBuilder: (_, anim, __, child) => FadeTransition(opacity: anim, child: child),
        ),
        (_) => false,
      );
    } catch (e) {
      if (!mounted) return;
      _showSnack(e.toString().replaceAll("Exception: ", ""), error: true);
    } finally {
      if (mounted) setState(() => _loading = false);
    }
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
          title: Text(
            "Create Account",
            style: GoogleFonts.poppins(color: _navy, fontWeight: FontWeight.w500, fontSize: 17),
          ),
          centerTitle: true,
        ),
        body: SingleChildScrollView(
          padding: const EdgeInsets.fromLTRB(24, 8, 24, 40),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              const SizedBox(height: 4),
              Text(
                _otpSent ? "Verify Your Number" : "Join Jago Today",
                style: GoogleFonts.poppins(fontSize: 26, fontWeight: FontWeight.w400, color: _navy),
              ),
              const SizedBox(height: 4),
              Text(
                _otpSent
                    ? "We sent a 6-digit code to +91 ${_phoneCtrl.text}"
                    : "Create your account with Firebase Phone OTP",
                style: GoogleFonts.poppins(fontSize: 13, color: const Color(0xFF94A3B8)),
              ),
              const SizedBox(height: 28),
              _buildLabel("Full Name"),
              const SizedBox(height: 8),
              _buildInput(
                controller: _nameCtrl,
                hint: "Enter your full name",
                icon: Icons.person_outline_rounded,
                textCap: TextCapitalization.words,
                enabled: !_otpSent,
              ),
              const SizedBox(height: 16),
              _buildLabel("Phone Number"),
              const SizedBox(height: 8),
              _buildPhoneInput(enabled: !_otpSent),
              const SizedBox(height: 16),
              _buildLabel("Email (Optional)"),
              const SizedBox(height: 8),
              _buildInput(
                controller: _emailCtrl,
                hint: "your@email.com",
                icon: Icons.mail_outline_rounded,
                keyboard: TextInputType.emailAddress,
                enabled: !_otpSent,
              ),
              if (_otpSent) ...[
                const SizedBox(height: 16),
                _buildLabel("Enter OTP"),
                const SizedBox(height: 8),
                _buildInput(
                  controller: _otpCtrl,
                  hint: "6-digit code",
                  icon: Icons.lock_outline_rounded,
                  keyboard: TextInputType.number,
                  inputFormatters: [
                    FilteringTextInputFormatter.digitsOnly,
                    LengthLimitingTextInputFormatter(6),
                  ],
                ),
                const SizedBox(height: 10),
                Center(
                  child: _seconds > 0
                      ? Text("Resend in ${_seconds}s", style: GoogleFonts.poppins(fontSize: 13, color: JT.textSecondary))
                      : GestureDetector(
                          onTap: _sendOtp,
                          child: Text(
                            "Resend OTP",
                            style: GoogleFonts.poppins(color: JT.primary, fontWeight: FontWeight.w500, fontSize: 13),
                          ),
                        ),
                ),
              ],
              const SizedBox(height: 32),
              SizedBox(
                width: double.infinity,
                height: 58,
                child: DecoratedBox(
                  decoration: BoxDecoration(
                    gradient: _loading
                        ? null
                        : const LinearGradient(
                            colors: [Color(0xFF56CCF2), Color(0xFF1A6FE0)],
                            begin: Alignment.centerLeft,
                            end: Alignment.centerRight,
                          ),
                    color: _loading ? _blue.withValues(alpha: 0.4) : null,
                    borderRadius: BorderRadius.circular(18),
                    boxShadow: _loading
                        ? []
                        : [
                            BoxShadow(
                              color: _blue.withValues(alpha: 0.4),
                              blurRadius: 20,
                              offset: const Offset(0, 8),
                            ),
                          ],
                  ),
                  child: ElevatedButton(
                    onPressed: _loading ? null : (_otpSent ? _verifyAndCreateAccount : _sendOtp),
                    style: ElevatedButton.styleFrom(
                      backgroundColor: Colors.transparent,
                      shadowColor: Colors.transparent,
                      disabledBackgroundColor: Colors.transparent,
                      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(18)),
                      elevation: 0,
                    ),
                    child: _loading
                        ? const SizedBox(
                            width: 24,
                            height: 24,
                            child: CircularProgressIndicator(color: Colors.white, strokeWidth: 2.5),
                          )
                        : Text(
                            _otpSent ? "Verify & Create Account" : "Send OTP",
                            style: GoogleFonts.poppins(fontSize: 17, fontWeight: FontWeight.w500, color: Colors.white),
                          ),
                  ),
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }

  Widget _buildLabel(String label) {
    return Text(
      label,
      style: GoogleFonts.poppins(fontSize: 13, fontWeight: FontWeight.w500, color: _navy),
    );
  }

  Widget _buildPhoneInput({required bool enabled}) {
    return Container(
      decoration: BoxDecoration(
        color: const Color(0xFFF8FAFC),
        borderRadius: BorderRadius.circular(16),
        border: Border.all(color: const Color(0xFFE2E8F0)),
      ),
      child: Row(
        children: [
          Padding(
            padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 18),
            child: Text("+91", style: GoogleFonts.poppins(fontSize: 15, fontWeight: FontWeight.w500, color: _navy)),
          ),
          Container(width: 1, height: 24, color: const Color(0xFFE2E8F0)),
          Expanded(
            child: TextField(
              controller: _phoneCtrl,
              enabled: enabled,
              keyboardType: TextInputType.phone,
              inputFormatters: [
                FilteringTextInputFormatter.digitsOnly,
                LengthLimitingTextInputFormatter(10),
              ],
              style: GoogleFonts.poppins(fontSize: 15, fontWeight: FontWeight.w400, color: _navy),
              decoration: InputDecoration(
                hintText: "Enter 10-digit number",
                hintStyle: GoogleFonts.poppins(color: const Color(0xFF94A3B8)),
                border: InputBorder.none,
                contentPadding: const EdgeInsets.symmetric(horizontal: 16, vertical: 16),
              ),
            ),
          ),
        ],
      ),
    );
  }

  Widget _buildInput({
    required TextEditingController controller,
    required String hint,
    required IconData icon,
    TextInputType keyboard = TextInputType.text,
    TextCapitalization textCap = TextCapitalization.none,
    List<TextInputFormatter>? inputFormatters,
    bool enabled = true,
  }) {
    return Container(
      decoration: BoxDecoration(
        color: const Color(0xFFF8FAFC),
        borderRadius: BorderRadius.circular(16),
        border: Border.all(color: const Color(0xFFE2E8F0)),
      ),
      child: TextField(
        controller: controller,
        enabled: enabled,
        keyboardType: keyboard,
        textCapitalization: textCap,
        inputFormatters: inputFormatters,
        style: GoogleFonts.poppins(fontSize: 15, fontWeight: FontWeight.w400, color: _navy),
        decoration: InputDecoration(
          hintText: hint,
          hintStyle: GoogleFonts.poppins(color: const Color(0xFF94A3B8)),
          prefixIcon: Icon(icon, color: JT.primary, size: 20),
          border: InputBorder.none,
          contentPadding: const EdgeInsets.symmetric(horizontal: 16, vertical: 16),
        ),
      ),
    );
  }
}
