import 'dart:async';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:google_fonts/google_fonts.dart';
import 'package:pin_code_fields/pin_code_fields.dart';
import 'package:sms_autofill/sms_autofill.dart';
import '../../config/jago_theme.dart';
import '../../services/auth_service.dart';
import '../../services/firebase_otp_service.dart';
import '../main_screen.dart';

class OtpScreen extends StatefulWidget {
  final String phone;
  final String? firebaseVerificationId;
  const OtpScreen({super.key, required this.phone, this.firebaseVerificationId, String otp = ''});
  @override
  State<OtpScreen> createState() => _OtpScreenState();
}

class _OtpScreenState extends State<OtpScreen> with SingleTickerProviderStateMixin, CodeAutoFill {
  final _otpCtrl = TextEditingController();
  bool _loading = false;
  bool _verifyInFlight = false;
  bool _verifyCompleted = false;
  int _seconds = 60;
  Timer? _timer;
  String? _verificationId;
  String? _otpProvider;
  bool _hasError = false;

  @override
  void codeUpdated() {
    // SMS auto-read fired — fill the box and auto-verify
    if (code != null && code!.length == 6 && mounted && !_verifyCompleted) {
      _otpCtrl.text = code!;
      _verify();
    }
  }

  late AnimationController _slideCtrl;
  late Animation<Offset> _slideAnim;

  static const Color _blue = JT.primary;
  static const Color _navy = JT.textPrimary;

  @override
  void initState() {
    super.initState();
    _verificationId = widget.firebaseVerificationId;
    _otpProvider = _verificationId != null ? 'firebase' : 'server';
    _startTimer();
    SmsAutoFill().listenForCode(); // start listening for SMS OTP auto-read

    _slideCtrl = AnimationController(vsync: this, duration: const Duration(milliseconds: 550));
    _slideAnim = Tween<Offset>(begin: const Offset(0, 0.4), end: Offset.zero)
        .animate(CurvedAnimation(parent: _slideCtrl, curve: Curves.easeOutCubic));
    Future.delayed(const Duration(milliseconds: 50), () {
      if (mounted) _slideCtrl.forward();
    });
  }

  void _startTimer() {
    _timer?.cancel();
    setState(() => _seconds = 60);
    _timer = Timer.periodic(const Duration(seconds: 1), (t) {
      if (_seconds == 0) { t.cancel(); return; }
      if (mounted) setState(() => _seconds--);
    });
  }

  Future<void> _verify() async {
    if (_otpCtrl.text.length != 6) return;
    if (_verifyInFlight || _verifyCompleted) return;
    _verifyInFlight = true;
    setState(() { _loading = true; _hasError = false; });
    try {
      Map<String, dynamic> res;
      if ((_otpProvider ?? 'server') == 'firebase') {
        try {
          final idToken = await FirebaseOtpService.verifyOtp(
            smsCode: _otpCtrl.text,
            verificationId: _verificationId,
          );
          res = await AuthService.verifyFirebaseToken(idToken, widget.phone, 'customer');
        } catch (e) {
          String? firebaseResendError;
          var firebaseResent = false;
          await FirebaseOtpService.sendOtp(
            phoneNumber: '+91${widget.phone}',
            forceResend: true,
            onCodeSent: (verificationId) {
              _verificationId = verificationId;
              firebaseResent = true;
            },
            onError: (error) {
              firebaseResendError = error;
            },
          );
          if (!mounted) return;
          _verifyCompleted = false;
          setState(() { _loading = false; _hasError = true; });
          _otpCtrl.clear();
          if (firebaseResent && _verificationId != null) {
            _otpProvider = 'firebase';
            _startTimer();
            _showSnack('Firebase verification expired. We sent a fresh OTP. Enter the new code.', error: true);
          } else {
            final fallback = await AuthService.sendOtp(widget.phone, 'customer', true);
            if (!mounted) return;
            if (fallback['success'] == true) {
              _verificationId = null;
              _otpProvider = 'server';
              _startTimer();
              _showSnack('Firebase verification failed. We sent a new SMS OTP instead. Enter the new code.', error: true);
            } else {
              _showSnack(
                fallback['message'] ?? firebaseResendError ?? e.toString().replaceAll('Exception: ', ''),
                error: true,
              );
            }
          }
          return;
        }
      } else {
        res = await AuthService.verifyOtp(widget.phone, _otpCtrl.text, 'customer');
      }
      if (!mounted) return;
      _verifyCompleted = true;
      setState(() => _loading = false);
      // success = true OR token present (server may return token without explicit success flag)
      if (res['success'] == true || res['token'] != null) {
        Navigator.pushAndRemoveUntil(context,
          PageRouteBuilder(
            pageBuilder: (_, __, ___) => const MainScreen(),
            transitionDuration: const Duration(milliseconds: 400),
            transitionsBuilder: (_, anim, __, child) => FadeTransition(opacity: anim, child: child),
          ),
          (_) => false);
      } else {
        _verifyCompleted = false;
        _showSnack(res['message'] ?? 'Verification failed. Try again.', error: true);
        setState(() => _hasError = true);
        _otpCtrl.clear();
      }
    } catch (e) {
      if (!mounted) return;
      _verifyCompleted = false;
      setState(() { _loading = false; _hasError = true; });
      _showSnack(e.toString().replaceAll('Exception: ', ''), error: true);
      _otpCtrl.clear();
    } finally {
      _verifyInFlight = false;
    }
  }

  void _showSnack(String msg, {bool error = false}) {
    if (!mounted) return;
    ScaffoldMessenger.of(context).showSnackBar(SnackBar(
      content: Text(msg, style: GoogleFonts.poppins(fontWeight: FontWeight.w400, color: Colors.white, fontSize: 13)),
      backgroundColor: error ? const Color(0xFFEF4444) : _blue,
      behavior: SnackBarBehavior.floating,
      margin: const EdgeInsets.fromLTRB(16, 0, 16, 16),
      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12)),
      duration: const Duration(seconds: 3),
    ));
  }

  @override
  void dispose() {
    _timer?.cancel();
    _otpCtrl.dispose();
    _slideCtrl.dispose();
    FirebaseOtpService.resetVerification();
    cancel(); // stop SMS listener
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final size = MediaQuery.of(context).size;
    return AnnotatedRegion<SystemUiOverlayStyle>(
      value: SystemUiOverlayStyle.light,
      child: Scaffold(
        backgroundColor: _blue,
        body: Stack(
          children: [
            // ── Gradient hero background ──
            Positioned(
              top: 0, left: 0, right: 0,
              height: size.height * 0.40,
              child: Container(
                decoration: const BoxDecoration(
                  gradient: LinearGradient(
                    begin: Alignment.topLeft,
                    end: Alignment.bottomRight,
                    colors: [JT.primary, Color(0xFF1A6FE0)],
                  ),
                ),
                child: Stack(
                  children: [
                    Positioned(top: -40, right: -40,
                      child: Container(width: 160, height: 160,
                        decoration: BoxDecoration(shape: BoxShape.circle,
                          color: Colors.white.withValues(alpha: 0.06)))),
                    Positioned(bottom: 20, left: -30,
                      child: Container(width: 120, height: 120,
                        decoration: BoxDecoration(shape: BoxShape.circle,
                          color: Colors.white.withValues(alpha: 0.04)))),
                    // Back button
                    Positioned(
                      top: MediaQuery.of(context).padding.top + 8,
                      left: 8,
                      child: IconButton(
                        icon: const Icon(Icons.arrow_back_ios_new_rounded, color: Colors.white, size: 22),
                        onPressed: () => Navigator.pop(context),
                      ),
                    ),
                    // Hero content
                    Center(
                      child: Column(
                        mainAxisSize: MainAxisSize.min,
                        children: [
                          const SizedBox(height: 24),
                          Container(
                            width: 72, height: 72,
                            decoration: BoxDecoration(
                              color: Colors.white.withValues(alpha: 0.15),
                              borderRadius: BorderRadius.circular(20),
                            ),
                            child: const Icon(Icons.lock_open_rounded, color: Colors.white, size: 36),
                          ),
                          const SizedBox(height: 16),
                          Text(
                            'OTP Verification',
                            style: GoogleFonts.poppins(
                              color: Colors.white,
                              fontSize: 22,
                              fontWeight: FontWeight.w500,
                            ),
                          ),
                          const SizedBox(height: 6),
                          Text(
                            'Code sent to +91 ${widget.phone}',
                            style: GoogleFonts.poppins(
                              color: Colors.white.withValues(alpha: 0.75),
                              fontSize: 13,
                              fontWeight: FontWeight.w400,
                            ),
                          ),
                        ],
                      ),
                    ),
                  ],
                ),
              ),
            ),

            // ── Bottom card ──
            Positioned(
              bottom: 0, left: 0, right: 0,
              child: SlideTransition(
                position: _slideAnim,
                child: Container(
                  constraints: BoxConstraints(minHeight: size.height * 0.62),
                  decoration: const BoxDecoration(
                    color: Colors.white,
                    borderRadius: BorderRadius.vertical(top: Radius.circular(32)),
                    boxShadow: [
                      BoxShadow(color: Color(0x1A000000), blurRadius: 24, offset: Offset(0, -6)),
                    ],
                  ),
                  child: SingleChildScrollView(
                    padding: const EdgeInsets.fromLTRB(28, 28, 28, 40),
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        // Drag handle
                        Center(
                          child: Container(
                            width: 40, height: 4,
                            margin: const EdgeInsets.only(bottom: 24),
                            decoration: BoxDecoration(
                              color: const Color(0xFFE2E8F0),
                              borderRadius: BorderRadius.circular(2),
                            ),
                          ),
                        ),

                        Text(
                          'Enter 6-digit OTP',
                          style: GoogleFonts.poppins(
                            fontSize: 20,
                            fontWeight: FontWeight.w400,
                            color: _navy,
                          ),
                        ),
                        const SizedBox(height: 4),
                        Text(
                          'Check your SMS for the verification code',
                          style: GoogleFonts.poppins(
                            fontSize: 13,
                            color: const Color(0xFF94A3B8),
                          ),
                        ),

                        const SizedBox(height: 32),

                        // OTP PIN input
                        PinCodeTextField(
                          appContext: context,
                          length: 6,
                          controller: _otpCtrl,
                          keyboardType: TextInputType.number,
                          animationType: AnimationType.scale,
                          pinTheme: PinTheme(
                            shape: PinCodeFieldShape.box,
                            borderRadius: BorderRadius.circular(14),
                            fieldHeight: 56,
                            fieldWidth: 48,
                            activeFillColor: Colors.white,
                            inactiveFillColor: const Color(0xFFF8FAFC),
                            selectedFillColor: const Color(0xFFEBF4FF),
                            activeColor: _blue,
                            inactiveColor: _hasError ? const Color(0xFFEF4444) : const Color(0xFFE2E8F0),
                            selectedColor: _blue,
                            errorBorderColor: const Color(0xFFEF4444),
                            borderWidth: 1.5,
                          ),
                          enableActiveFill: true,
                          textStyle: GoogleFonts.poppins(
                            fontSize: 22,
                            fontWeight: FontWeight.w400,
                            color: _navy,
                          ),
                          onCompleted: (_) => _verify(),
                          onChanged: (v) {
                            if (_hasError && v.isNotEmpty) setState(() => _hasError = false);
                          },
                        ),

                        const SizedBox(height: 12),

                        // Timer / resend
                        Center(
                          child: _seconds > 0
                            ? RichText(
                                text: TextSpan(
                                  style: GoogleFonts.poppins(fontSize: 13, color: const Color(0xFF94A3B8)),
                                  children: [
                                    const TextSpan(text: 'Resend OTP in '),
                                    TextSpan(
                                      text: '${_seconds}s',
                                      style: GoogleFonts.poppins(
                                        color: _blue,
                                        fontWeight: FontWeight.w500,
                                        fontSize: 13,
                                      ),
                                    ),
                                  ],
                                ),
                              )
                            : GestureDetector(
                                onTap: () {
                                  _otpCtrl.clear();
                                  setState(() => _hasError = false);
                                  _startTimer();
                                  FirebaseOtpService.sendOtp(
                                    phoneNumber: '+91${widget.phone}',
                                    forceResend: true,
                                    onCodeSent: (vId) => setState(() => _verificationId = vId),
                                    onError: (err) => _showSnack(err, error: true),
                                  );
                                },
                                child: Text(
                                  'Resend OTP',
                                  style: GoogleFonts.poppins(
                                    color: _blue,
                                    fontWeight: FontWeight.w500,
                                    fontSize: 13,
                                  ),
                                ),
                              ),
                        ),

                        const SizedBox(height: 32),

                        // Verify button
                        SizedBox(
                          width: double.infinity,
                          height: 58,
                          child: DecoratedBox(
                            decoration: BoxDecoration(
                              gradient: _loading ? null : const LinearGradient(
                                colors: [Color(0xFF56CCF2), Color(0xFF1A6FE0)],
                                begin: Alignment.centerLeft,
                                end: Alignment.centerRight,
                              ),
                              color: _loading ? _blue.withValues(alpha: 0.4) : null,
                              borderRadius: BorderRadius.circular(18),
                              boxShadow: _loading ? [] : [
                                BoxShadow(
                                  color: _blue.withValues(alpha: 0.4),
                                  blurRadius: 20,
                                  offset: const Offset(0, 8),
                                ),
                              ],
                            ),
                            child: ElevatedButton(
                              onPressed: _loading ? null : _verify,
                              style: ElevatedButton.styleFrom(
                                backgroundColor: Colors.transparent,
                                shadowColor: Colors.transparent,
                                disabledBackgroundColor: Colors.transparent,
                                shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(18)),
                                elevation: 0,
                              ),
                              child: _loading
                                ? const SizedBox(width: 24, height: 24,
                                    child: CircularProgressIndicator(color: Colors.white, strokeWidth: 2.5))
                                : Text(
                                    'Verify & Continue',
                                    style: GoogleFonts.poppins(
                                      fontSize: 15,
                                      fontWeight: FontWeight.w400,
                                      color: Colors.white,
                                      letterSpacing: 0.1,
                                    ),
                                  ),
                            ),
                          ),
                        ),

                        const SizedBox(height: 20),

                        // Change number
                        Center(
                          child: GestureDetector(
                            onTap: () => Navigator.pop(context),
                            child: Text(
                              '← Change Phone Number',
                              style: GoogleFonts.poppins(
                                color: const Color(0xFF94A3B8),
                                fontWeight: FontWeight.w400,
                                fontSize: 13,
                              ),
                            ),
                          ),
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
}
