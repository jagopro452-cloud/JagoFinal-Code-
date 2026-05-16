import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:google_fonts/google_fonts.dart';
import 'package:sms_autofill/sms_autofill.dart';

import '../../config/jago_theme.dart';
import '../../services/auth_service.dart';
import '../../services/firebase_otp_service.dart';
import '../home/home_screen.dart';
import 'register_screen.dart';

class LoginScreen extends StatefulWidget {
  const LoginScreen({super.key});

  @override
  State<LoginScreen> createState() => _LoginScreenState();
}

class _LoginScreenState extends State<LoginScreen> with TickerProviderStateMixin, CodeAutoFill {
  final _phoneCtrl = TextEditingController();
  final _otpCtrl = TextEditingController();

  bool _otpSent = false;
  bool _loading = false;
  bool _otpVerifyInFlight = false;
  bool _otpVerifyCompleted = false;
  int _seconds = 0;
  Timer? _timer;
  String? _firebaseVerificationId;

  late AnimationController _cardCtrl;
  late Animation<Offset> _cardSlide;
  late AnimationController _logoCtrl;
  late Animation<double> _logoFade;

  static const _blue = JT.primary;
  static const _dark = Color(0xFF080F1E);

  @override
  void initState() {
    super.initState();
    _cardCtrl = AnimationController(vsync: this, duration: const Duration(milliseconds: 700));
    _cardSlide = Tween<Offset>(begin: const Offset(0, 1), end: Offset.zero)
        .animate(CurvedAnimation(parent: _cardCtrl, curve: Curves.easeOutCubic));

    _logoCtrl = AnimationController(vsync: this, duration: const Duration(milliseconds: 600));
    _logoFade = Tween<double>(begin: 0.0, end: 1.0)
        .animate(CurvedAnimation(parent: _logoCtrl, curve: Curves.easeOut));

    _logoCtrl.forward();
    Future.delayed(const Duration(milliseconds: 200), () {
      if (mounted) _cardCtrl.forward();
    });
  }

  @override
  void codeUpdated() {
    if (code != null && _otpSent && !_otpVerifyCompleted) {
      final match = RegExp(r"\d{6}").firstMatch(code!);
      if (match != null && mounted) {
        final otp = match.group(0)!;
        setState(() => _otpCtrl.text = otp);
        _verifyOtp();
      }
    }
  }

  @override
  void dispose() {
    cancel();
    FirebaseOtpService.resetVerification();
    _cardCtrl.dispose();
    _logoCtrl.dispose();
    _timer?.cancel();
    _phoneCtrl.dispose();
    _otpCtrl.dispose();
    super.dispose();
  }

  void _snack(String msg, {bool error = false}) {
    if (!mounted) return;
    ScaffoldMessenger.of(context).clearSnackBars();
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(
        content: Text(msg, style: GoogleFonts.poppins(fontWeight: FontWeight.w400, color: Colors.white, fontSize: 13)),
        backgroundColor: error ? const Color(0xFFEF4444) : const Color(0xFF10B981),
        behavior: SnackBarBehavior.floating,
        margin: const EdgeInsets.fromLTRB(16, 0, 16, 16),
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12)),
        duration: const Duration(seconds: 3),
      ),
    );
  }

  void _showErrorDialog(String title, String message) {
    if (!mounted) return;
    showDialog(
      context: context,
      builder: (ctx) => AlertDialog(
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(16)),
        title: Row(
          children: [
            const Icon(Icons.error_outline, color: Colors.red, size: 24),
            const SizedBox(width: 8),
            Expanded(child: Text(title, style: GoogleFonts.poppins(fontWeight: FontWeight.w500, fontSize: 16))),
          ],
        ),
        content: Text(message, style: GoogleFonts.poppins(fontSize: 14)),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(ctx),
            child: Text("OK", style: GoogleFonts.poppins(fontWeight: FontWeight.w500, color: _blue)),
          ),
        ],
      ),
    );
  }

  void _startTimer() {
    _timer?.cancel();
    _seconds = 30;
    _timer = Timer.periodic(const Duration(seconds: 1), (t) {
      if (!mounted || _seconds == 0) {
        t.cancel();
        return;
      }
      setState(() => _seconds--);
    });
  }

  Future<void> _resetOtpFlow() async {
    _timer?.cancel();
    _firebaseVerificationId = null;
    _otpVerifyInFlight = false;
    _otpVerifyCompleted = false;
    await FirebaseOtpService.resetVerification();
    if (!mounted) return;
    setState(() {
      _otpSent = false;
      _loading = false;
      _otpCtrl.clear();
    });
  }

  Future<void> _sendOtp() async {
    final phone = _phoneCtrl.text.trim();
    if (phone.length != 10) {
      _snack("Enter a valid 10-digit number", error: true);
      return;
    }
    setState(() => _loading = true);
    _firebaseVerificationId = null;
    _otpVerifyInFlight = false;
    _otpVerifyCompleted = false;
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
      _snack("OTP sent to +91$phone");
      listenForCode();
      return;
    }

    setState(() => _loading = false);
    _snack(firebaseError ?? "Failed to send OTP", error: true);
  }

  Future<void> _verifyOtp() async {
    final phone = _phoneCtrl.text.trim();
    final otp = _otpCtrl.text.trim();
    if (otp.length != 6) {
      _snack("Enter the 6-digit OTP", error: true);
      return;
    }
    if (_otpVerifyInFlight || _otpVerifyCompleted) return;
    if (_firebaseVerificationId == null) {
      _showErrorDialog("Verification Failed", "OTP session expired. Please resend OTP and try again.");
      return;
    }
    _otpVerifyInFlight = true;
    setState(() => _loading = true);

    try {
      final idToken = await FirebaseOtpService.verifyOtp(
        smsCode: otp,
        verificationId: _firebaseVerificationId,
      );
      if (!mounted) return;
      final res = await AuthService.verifyFirebaseToken(idToken, phone, "driver");
      if (!mounted) return;
      if (res["success"] == true || res["token"] != null) {
        _otpVerifyCompleted = true;
        setState(() => _loading = false);
        Navigator.pushAndRemoveUntil(
          context,
          MaterialPageRoute(builder: (_) => const HomeScreen()),
          (_) => false,
        );
      } else {
        _otpVerifyCompleted = false;
        setState(() => _loading = false);
        _otpCtrl.clear();
        _showErrorDialog("Login Failed", res["message"]?.toString() ?? "Firebase verification failed.");
      }
    } catch (e) {
      if (!mounted) return;
      _otpVerifyCompleted = false;
      setState(() => _loading = false);
      _otpCtrl.clear();
      _showErrorDialog("Verification Failed", e.toString().replaceAll("Exception: ", ""));
    } finally {
      _otpVerifyInFlight = false;
    }
  }

  @override
  Widget build(BuildContext context) {
    final size = MediaQuery.of(context).size;

    return AnnotatedRegion<SystemUiOverlayStyle>(
      value: const SystemUiOverlayStyle(statusBarColor: Colors.transparent, statusBarIconBrightness: Brightness.dark),
      child: Scaffold(
        backgroundColor: _blue,
        resizeToAvoidBottomInset: true,
        body: Theme(
          data: ThemeData.light().copyWith(textTheme: GoogleFonts.poppinsTextTheme()),
          child: Stack(
            children: [
              Positioned.fill(
                child: Container(
                  decoration: BoxDecoration(
                    gradient: LinearGradient(
                      begin: Alignment.topCenter,
                      end: Alignment.bottomCenter,
                      colors: [_blue, const Color(0xFF1565D8), Colors.white],
                      stops: const [0.0, 0.42, 0.42],
                    ),
                  ),
                ),
              ),
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
                            borderRadius: BorderRadius.circular(20),
                            color: Colors.white.withValues(alpha: 0.2),
                            border: Border.all(color: Colors.white.withValues(alpha: 0.4), width: 1.5),
                            boxShadow: [
                              BoxShadow(
                                color: Colors.black.withValues(alpha: 0.15),
                                blurRadius: 24,
                                offset: const Offset(0, 8),
                              ),
                            ],
                          ),
                          child: Padding(
                            padding: const EdgeInsets.all(10),
                            child: JT.logoWhite(height: 44),
                          ),
                        ),
                        const SizedBox(height: 18),
                        JT.logoWhite(height: 36),
                        const SizedBox(height: 6),
                        Text(
                          "Drive with Firebase OTP",
                          style: GoogleFonts.poppins(
                            fontSize: 12,
                            fontWeight: FontWeight.w400,
                            color: Colors.white.withValues(alpha: 0.75),
                            letterSpacing: 0.5,
                          ),
                        ),
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
                    decoration: const BoxDecoration(
                      color: Colors.white,
                      borderRadius: BorderRadius.vertical(top: Radius.circular(32)),
                    ),
                    child: SingleChildScrollView(
                      padding: EdgeInsets.only(
                        left: 28,
                        right: 28,
                        top: 8,
                        bottom: MediaQuery.of(context).viewInsets.bottom + 32,
                      ),
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Center(
                            child: Container(
                              margin: const EdgeInsets.only(top: 12, bottom: 24),
                              width: 36,
                              height: 4,
                              decoration: BoxDecoration(
                                color: const Color(0xFFE2E8F0),
                                borderRadius: BorderRadius.circular(2),
                              ),
                            ),
                          ),
                          Text(
                            _otpSent ? "Enter OTP" : "Sign In",
                            style: GoogleFonts.poppins(fontSize: 26, fontWeight: FontWeight.w400, color: _dark),
                          ),
                          const SizedBox(height: 4),
                          Text(
                            _otpSent ? "Sent to +91 ${_phoneCtrl.text}" : "Driver login uses Firebase Phone OTP only",
                            style: GoogleFonts.poppins(fontSize: 13, color: const Color(0xFF94A3B8)),
                          ),
                          const SizedBox(height: 28),
                          if (!_otpSent) ...[
                            _buildPhoneField(),
                            const SizedBox(height: 24),
                            _buildButton("Get OTP", _sendOtp),
                          ] else ...[
                            _buildOtpField(),
                            const SizedBox(height: 12),
                            Center(
                              child: _seconds > 0
                                  ? Text("Resend in ${_seconds}s", style: GoogleFonts.poppins(color: const Color(0xFF94A3B8), fontSize: 13))
                                  : GestureDetector(
                                      onTap: () async {
                                        await _resetOtpFlow();
                                        await _sendOtp();
                                      },
                                      child: Text(
                                        "Resend OTP",
                                        style: GoogleFonts.poppins(color: _blue, fontWeight: FontWeight.w500, fontSize: 13),
                                      ),
                                    ),
                            ),
                            const SizedBox(height: 28),
                            _buildButton("Verify & Login", _verifyOtp),
                            const SizedBox(height: 12),
                            Center(
                              child: GestureDetector(
                                onTap: _resetOtpFlow,
                                child: Text(
                                  "Change Number",
                                  style: GoogleFonts.poppins(color: const Color(0xFF94A3B8), fontWeight: FontWeight.w500, fontSize: 13),
                                ),
                              ),
                            ),
                          ],
                          const SizedBox(height: 28),
                          Row(
                            children: [
                              const Expanded(child: Divider(color: Color(0xFFF1F5F9), thickness: 1.5)),
                              Padding(
                                padding: const EdgeInsets.symmetric(horizontal: 14),
                                child: Text("or", style: GoogleFonts.poppins(color: const Color(0xFFCBD5E1), fontSize: 13)),
                              ),
                              const Expanded(child: Divider(color: Color(0xFFF1F5F9), thickness: 1.5)),
                            ],
                          ),
                          const SizedBox(height: 20),
                          Row(
                            mainAxisAlignment: MainAxisAlignment.center,
                            children: [
                              Text("New driver?  ", style: GoogleFonts.poppins(color: const Color(0xFF94A3B8), fontSize: 14)),
                              GestureDetector(
                                onTap: () => Navigator.push(context, MaterialPageRoute(builder: (_) => const RegisterScreen())),
                                child: Text(
                                  "Start Onboarding",
                                  style: GoogleFonts.poppins(color: _blue, fontWeight: FontWeight.w400, fontSize: 14),
                                ),
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
      ),
    );
  }

  Widget _buildPhoneField() {
    return Container(
      decoration: BoxDecoration(
        color: Colors.white,
        borderRadius: BorderRadius.circular(16),
        border: Border.all(color: const Color(0xFFD8E6F8), width: 1.2),
      ),
      child: Row(
        children: [
          Container(
            padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 18),
            decoration: BoxDecoration(
              color: const Color(0xFFF2F7FF),
              borderRadius: const BorderRadius.only(topLeft: Radius.circular(14), bottomLeft: Radius.circular(14)),
              border: const Border(right: BorderSide(color: Color(0xFFD8E6F8), width: 1.2)),
            ),
            child: Text("+91", style: GoogleFonts.poppins(fontSize: 16, fontWeight: FontWeight.w400, color: JT.primary)),
          ),
          Expanded(
            child: TextField(
              controller: _phoneCtrl,
              keyboardType: TextInputType.phone,
              inputFormatters: [
                FilteringTextInputFormatter.digitsOnly,
                LengthLimitingTextInputFormatter(10),
              ],
              style: GoogleFonts.poppins(fontSize: 16, fontWeight: FontWeight.w400, color: JT.textPrimary),
              decoration: InputDecoration(
                hintText: "Mobile number",
                hintStyle: GoogleFonts.poppins(fontSize: 14, color: JT.iconInactive),
                border: InputBorder.none,
                contentPadding: const EdgeInsets.symmetric(horizontal: 16, vertical: 18),
              ),
            ),
          ),
        ],
      ),
    );
  }

  Widget _buildOtpField() {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 4),
      decoration: BoxDecoration(
        color: Colors.white,
        borderRadius: BorderRadius.circular(16),
        border: Border.all(color: const Color(0xFFD8E6F8), width: 1.4),
      ),
      child: TextField(
        controller: _otpCtrl,
        keyboardType: TextInputType.number,
        textAlign: TextAlign.center,
        autofocus: true,
        maxLength: 6,
        inputFormatters: [
          FilteringTextInputFormatter.digitsOnly,
          LengthLimitingTextInputFormatter(6),
        ],
        style: GoogleFonts.poppins(fontSize: 22, fontWeight: FontWeight.w500, color: JT.textPrimary, letterSpacing: 8),
        decoration: InputDecoration(
          hintText: "------",
          hintStyle: GoogleFonts.poppins(color: JT.iconInactive, letterSpacing: 8),
          border: InputBorder.none,
          counterText: "",
        ),
        onChanged: (code) {
          if (code.length == 6) _verifyOtp();
        },
      ),
    );
  }

  Widget _buildButton(String label, VoidCallback onTap) {
    return SizedBox(
      width: double.infinity,
      height: 56,
      child: ElevatedButton(
        onPressed: _loading ? null : onTap,
        style: ElevatedButton.styleFrom(
          backgroundColor: JT.primary,
          foregroundColor: Colors.white,
          shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(18)),
          elevation: 0,
        ),
        child: _loading
            ? const SizedBox(
                width: 24,
                height: 24,
                child: CircularProgressIndicator(color: Colors.white, strokeWidth: 2.5),
              )
            : Text(label, style: GoogleFonts.poppins(fontSize: 16, fontWeight: FontWeight.w500)),
      ),
    );
  }
}
