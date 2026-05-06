import 'dart:async';
import 'package:flutter/material.dart';
import '../../config/jago_theme.dart';
import 'package:flutter/services.dart';
import 'package:google_fonts/google_fonts.dart';
import 'package:sms_autofill/sms_autofill.dart';
import '../../services/auth_service.dart';
import '../../services/firebase_otp_service.dart';
import '../home/home_screen.dart';
import 'register_screen.dart';
import 'forgot_password_screen.dart';

class LoginScreen extends StatefulWidget {
  const LoginScreen({super.key});
  @override
  State<LoginScreen> createState() => _LoginScreenState();
}

class _LoginScreenState extends State<LoginScreen> with TickerProviderStateMixin, CodeAutoFill {
  final _phoneCtrl = TextEditingController();
  final _otpCtrl = TextEditingController();
  final _passwordCtrl = TextEditingController();

  bool _otpSent = false;
  bool _showPassword = false;
  bool _usePassword = false;
  bool _loading = false;
  bool _otpVerifyInFlight = false;
  bool _otpVerifyCompleted = false;
  int _seconds = 0;
  Timer? _timer;
  String? _firebaseVerificationId;
  String? _otpProvider;

  @override
  void codeUpdated() {
    // Called by CodeAutoFill when SMS is auto-read
    if (code != null && _otpSent && !_otpVerifyCompleted) {
      final match = RegExp(r'\d{6}').firstMatch(code!);
      if (match != null && mounted) {
        final otp = match.group(0)!;
        setState(() => _otpCtrl.text = otp);
        _verifyOtp();
      }
    }
  }

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
  void dispose() {
    cancel(); // Stop SMS auto-read listening
    FirebaseOtpService.resetVerification();
    _cardCtrl.dispose();
    _logoCtrl.dispose();
    _timer?.cancel();
    _phoneCtrl.dispose();
    _otpCtrl.dispose();
    _passwordCtrl.dispose();
    super.dispose();
  }

  void _snack(String msg, {bool error = false}) {
    if (!mounted) return;
    ScaffoldMessenger.of(context).clearSnackBars();
    ScaffoldMessenger.of(context).showSnackBar(SnackBar(
      content: Text(msg, style: GoogleFonts.poppins(fontWeight: FontWeight.w400, color: Colors.white, fontSize: 13)),
      backgroundColor: error ? const Color(0xFFEF4444) : const Color(0xFF10B981),
      behavior: SnackBarBehavior.floating,
      margin: const EdgeInsets.fromLTRB(16, 0, 16, 16),
      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12)),
      duration: const Duration(seconds: 3),
    ));
  }

  void _showErrorDialog(String title, String message) {
    if (!mounted) return;
    showDialog(
      context: context,
      builder: (ctx) => AlertDialog(
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(16)),
        title: Row(children: [
          const Icon(Icons.error_outline, color: Colors.red, size: 24),
          const SizedBox(width: 8),
          Expanded(child: Text(title, style: GoogleFonts.poppins(fontWeight: FontWeight.w500, fontSize: 16))),
        ]),
        content: Text(message, style: GoogleFonts.poppins(fontSize: 14)),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(ctx),
            child: Text('OK', style: GoogleFonts.poppins(fontWeight: FontWeight.w500, color: const Color(0xFF2F80ED))),
          ),
        ],
      ),
    );
  }

  String _friendlyOtpMessage(String? message) {
    final text = (message ?? '').trim();
    final lower = text.toLowerCase();
    if (lower.contains('too many') || lower.contains('attempt')) {
      return 'Too many OTP attempts detected. Please wait a moment before trying again.';
    }
    if (lower.contains('expired')) {
      return 'This OTP expired. Please resend and enter the latest code.';
    }
    if (lower.contains('cooldown') || lower.contains('wait')) {
      return 'Please wait a few seconds before requesting another OTP.';
    }
    return text.isNotEmpty ? text : 'Please check the latest OTP and try again.';
  }

  Future<bool> _sendServerOtpFallback(String phone, {String? preferredMessage}) async {
    final res = await AuthService.sendOtp(phone, 'driver', true);
    if (!mounted) return false;
    if (res['success'] != true) {
      setState(() => _loading = false);
      _snack(_friendlyOtpMessage(preferredMessage ?? res['message']), error: true);
      return false;
    }
    _firebaseVerificationId = null;
    _otpProvider = 'server';
    setState(() { _otpSent = true; _loading = false; });
    _startTimer();
    _snack('OTP sent to +91$phone via SMS');
    listenForCode();
    return true;
  }

  Widget _buildOtpHelpCard() {
    final isFirebase = (_otpProvider ?? 'firebase') == 'firebase';
    final title = isFirebase ? 'Use the latest OTP' : 'SMS OTP in progress';
    final message = isFirebase
        ? 'Enter the newest 6-digit code. If the OTP expires, resend and use the fresh code only.'
        : 'SMS OTP may take a few seconds. Avoid repeated taps until resend becomes available.';
    return Container(
      width: double.infinity,
      padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 12),
      decoration: BoxDecoration(
        color: const Color(0xFFF8FAFC),
        borderRadius: BorderRadius.circular(16),
        border: Border.all(color: const Color(0xFFE2E8F0)),
      ),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Container(
            width: 30,
            height: 30,
            decoration: BoxDecoration(
              color: _blue.withValues(alpha: 0.08),
              borderRadius: BorderRadius.circular(10),
            ),
            child: Icon(
              isFirebase ? Icons.shield_outlined : Icons.sms_outlined,
              color: _blue,
              size: 16,
            ),
          ),
          const SizedBox(width: 10),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  title,
                  style: GoogleFonts.poppins(
                    fontSize: 12,
                    fontWeight: FontWeight.w600,
                    color: _dark,
                  ),
                ),
                const SizedBox(height: 3),
                Text(
                  message,
                  style: GoogleFonts.poppins(
                    fontSize: 11.5,
                    fontWeight: FontWeight.w400,
                    color: const Color(0xFF64748B),
                    height: 1.4,
                  ),
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }

  void _startTimer() {
    _timer?.cancel();
    _seconds = 60;
    _timer = Timer.periodic(const Duration(seconds: 1), (t) {
      if (!mounted || _seconds == 0) { t.cancel(); return; }
      setState(() => _seconds--);
    });
  }

  Future<void> _resetOtpFlow() async {
    _timer?.cancel();
    _firebaseVerificationId = null;
    _otpProvider = null;
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
    if (phone.length != 10) { _snack('Enter a valid 10-digit number', error: true); return; }
    setState(() => _loading = true);
    _firebaseVerificationId = null;
    _otpProvider = null;
    _otpVerifyInFlight = false;
    _otpVerifyCompleted = false;
    await FirebaseOtpService.resetVerification();

    // PRIMARY: Firebase Phone Auth — await until code is sent or error
    bool firebaseSent = false;
    String? firebaseError;
    await FirebaseOtpService.sendOtp(
      phoneNumber: '+91$phone',
      onCodeSent: (verificationId) {
        _firebaseVerificationId = verificationId;
        firebaseSent = true;
      },
      onError: (error) { firebaseError = error; },
      // No auto-verify — see customer_app/lib/screens/auth/login_screen.dart
      // for the rationale (avoids credential-consumed-then-network-fail race).
      // SMS still auto-fills the textfield via CodeAutoFill below.
    );

    if (!mounted) return;

    if (firebaseSent) {
      // Notify server for rate-limiting (fire-and-forget — don't block user)
      _otpProvider = 'firebase';
      setState(() { _otpSent = true; _loading = false; });
      _startTimer();
      _snack('OTP sent to +91$phone');
      listenForCode();
      return;
    }

    firebaseError ??= 'OTP send failed. Retrying once...';
    if (FirebaseOtpService.shouldPreferServerFallback(firebaseError)) {
      await _sendServerOtpFallback(phone, preferredMessage: firebaseError);
      return;
    }
    await FirebaseOtpService.sendOtp(
      phoneNumber: '+91$phone',
      forceResend: true,
      onCodeSent: (verificationId) {
        _firebaseVerificationId = verificationId;
        firebaseSent = true;
      },
      onError: (error) { firebaseError = error; },
    );
    if (!mounted) return;
    if (firebaseSent) {
      _otpProvider = 'firebase';
      setState(() { _otpSent = true; _loading = false; });
      _startTimer();
      _snack('OTP sent to +91$phone');
      listenForCode();
      return;
    }

    await _sendServerOtpFallback(phone, preferredMessage: firebaseError);
  }

  Future<void> _verifyOtp() async {
    final phone = _phoneCtrl.text.trim();
    final otp = _otpCtrl.text.trim();
    if (otp.length != 6) { _snack('Enter the 6-digit OTP', error: true); return; }
    if (!_otpSent || _otpVerifyCompleted || _otpVerifyInFlight || _loading) return;
    _otpVerifyInFlight = true;
    setState(() => _loading = true);
    final otpProvider = _otpProvider ?? (_firebaseVerificationId != null ? 'firebase' : 'server');

    if (otpProvider == 'firebase') {
      try {
        if (_firebaseVerificationId == null) {
          throw Exception('OTP session expired. Please resend OTP and try again.');
        }
        final idToken = await FirebaseOtpService.verifyOtp(
          smsCode: otp,
          verificationId: _firebaseVerificationId,
        );
        if (!mounted) return;
        final res = await AuthService.verifyFirebaseToken(idToken, phone, 'driver');
        if (!mounted) return;
        _otpVerifyCompleted = true;
        setState(() => _loading = false);
        if (res['success'] == true || res['token'] != null) {
          Navigator.pushAndRemoveUntil(context,
            MaterialPageRoute(builder: (_) => const HomeScreen()), (_) => false);
        } else {
          _otpVerifyCompleted = false;
          _otpCtrl.clear();
          _showErrorDialog('Login Failed', res['message'] ?? 'Firebase verification failed. Please try again.');
        }
      } catch (e) {
        String? firebaseResendError;
        var firebaseResent = false;
        await FirebaseOtpService.sendOtp(
          phoneNumber: '+91$phone',
          forceResend: true,
          onCodeSent: (verificationId) {
            _firebaseVerificationId = verificationId;
            firebaseResent = true;
          },
          onError: (error) {
            firebaseResendError = error;
          },
        );
        if (!mounted) return;
        _otpVerifyCompleted = false;
        _otpCtrl.clear();
        if (firebaseResent && _firebaseVerificationId != null) {
          _otpProvider = 'firebase';
          setState(() => _loading = false);
          _startTimer();
          _showErrorDialog(
            'OTP Refreshed',
            'Your previous OTP expired or failed. We sent a fresh OTP. Please enter the new code.',
          );
          _otpVerifyInFlight = false;
          return;
        }
        final fallback = await AuthService.sendOtp(phone, 'driver', true);
        if (!mounted) return;
        if (fallback['success'] == true) {
          _firebaseVerificationId = null;
          _otpProvider = 'server';
          setState(() => _loading = false);
          _startTimer();
          _showErrorDialog(
            'OTP Refreshed',
            'Firebase verification failed. We sent a new SMS OTP instead. Please enter the new code.',
          );
        } else {
          setState(() => _loading = false);
          _showErrorDialog(
            'Verification Failed',
            _friendlyOtpMessage(fallback['message'] ?? firebaseResendError ?? e.toString().replaceAll('Exception: ', '')),
          );
        }
        _otpVerifyInFlight = false;
        return;
      } finally {
        _otpVerifyInFlight = false;
      }
      if (otpProvider == 'firebase') {
        return;
      }
    }

    // Fallback: verify with server OTP (works even when Firebase is blocked)
    try {
      final res = await AuthService.verifyOtp(phone, otp, 'driver');
      if (!mounted) return;
      _otpVerifyCompleted = true;
      setState(() => _loading = false);
      if (res['success'] == true || res['token'] != null) {
        Navigator.pushAndRemoveUntil(context,
          MaterialPageRoute(builder: (_) => const HomeScreen()), (_) => false);
      } else {
        _otpVerifyCompleted = false;
        _otpCtrl.clear();
        _showErrorDialog('Login Failed', _friendlyOtpMessage(res['message'] ?? 'Wrong OTP. Please try again.'));
      }
    } catch (e) {
      if (!mounted) return;
      _otpVerifyCompleted = false;
      setState(() => _loading = false);
      _otpCtrl.clear();
      _showErrorDialog('Verification Failed', _friendlyOtpMessage('Network error. Please try again.'));
    } finally {
      _otpVerifyInFlight = false;
    }
  }

  Future<void> _loginWithPassword() async {
    final phone = _phoneCtrl.text.trim();
    final pass = _passwordCtrl.text;
    if (phone.length != 10) { _snack('Enter a valid 10-digit number', error: true); return; }
    if (pass.length < 6) { _snack('Password must be at least 6 characters', error: true); return; }
    setState(() => _loading = true);
    final res = await AuthService.loginWithPassword(phone, pass);
    if (!mounted) return;
    setState(() => _loading = false);
    if (res['success'] == true || res['token'] != null) {
      Navigator.pushAndRemoveUntil(context, MaterialPageRoute(builder: (_) => const HomeScreen()), (_) => false);
    } else {
      _snack(res['message'] ?? 'Login failed', error: true);
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
          data: ThemeData.light().copyWith(
            textTheme: GoogleFonts.poppinsTextTheme(),
          ),
          child: Stack(
          children: [
            // Blue background
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

            // Top brand
            Positioned(
              top: 0, left: 0, right: 0,
              height: size.height * 0.42,
              child: FadeTransition(
                opacity: _logoFade,
                child: SafeArea(
                  child: Column(
                    mainAxisAlignment: MainAxisAlignment.center,
                    children: [
                      Container(
                        width: 76, height: 76,
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
                      Text('Earn. Drive. Grow.', style: GoogleFonts.poppins(
                        fontSize: 12, fontWeight: FontWeight.w400,
                        color: Colors.white.withValues(alpha: 0.75),
                        letterSpacing: 0.5,
                      )),
                    ],
                  ),
                ),
              ),
            ),

            // White bottom card
            Positioned(
              bottom: 0, left: 0, right: 0,
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
                      left: 28, right: 28, top: 8,
                      bottom: MediaQuery.of(context).viewInsets.bottom + 32,
                    ),
                    child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                      Center(child: Container(
                        margin: const EdgeInsets.only(top: 12, bottom: 24),
                        width: 36, height: 4,
                        decoration: BoxDecoration(
                          color: const Color(0xFFE2E8F0),
                          borderRadius: BorderRadius.circular(2),
                        ),
                      )),

                      Text(
                        _otpSent ? 'Enter OTP' : (_usePassword ? 'Welcome Back' : 'Sign In'),
                        style: GoogleFonts.poppins(fontSize: 26, fontWeight: FontWeight.w400, color: _dark),
                      ),
                      const SizedBox(height: 4),
                      Text(
                        _otpSent
                          ? 'Sent to +91 ${_phoneCtrl.text}'
                          : (_usePassword ? 'Login with your password' : 'Enter your mobile number'),
                        style: GoogleFonts.poppins(fontSize: 13, color: const Color(0xFF94A3B8)),
                      ),
                      const SizedBox(height: 28),

                      if (!_otpSent) ...[
                        _buildPhoneField(),
                        const SizedBox(height: 14),
                        if (_usePassword) ...[
                          _buildPasswordField(),
                          const SizedBox(height: 8),
                          Align(
                            alignment: Alignment.centerRight,
                            child: GestureDetector(
                              onTap: () => Navigator.push(context, MaterialPageRoute(builder: (_) => const ForgotPasswordScreen())),
                              child: Text('Forgot Password?', style: GoogleFonts.poppins(color: _blue, fontWeight: FontWeight.w400, fontSize: 13)),
                            ),
                          ),
                        ],
                        const SizedBox(height: 24),
                        _buildButton(_usePassword ? 'Login' : 'Get OTP', _usePassword ? _loginWithPassword : _sendOtp),
                        const SizedBox(height: 16),
                        Center(
                          child: GestureDetector(
                            onTap: () => setState(() { _usePassword = !_usePassword; }),
                            child: Text(
                              _usePassword ? 'Use OTP instead' : 'Use Password instead',
                              style: GoogleFonts.poppins(color: _blue, fontWeight: FontWeight.w400, fontSize: 13),
                            ),
                          ),
                        ),
                      ] else ...[
                        _buildOtpField(),
                        const SizedBox(height: 12),
                        Center(
                          child: _seconds > 0
                            ? Text('Resend in ${_seconds}s', style: GoogleFonts.poppins(color: const Color(0xFF94A3B8), fontSize: 13))
                            : GestureDetector(
                                onTap: () async { await _resetOtpFlow(); await _sendOtp(); },
                                child: Text('Resend OTP', style: GoogleFonts.poppins(color: _blue, fontWeight: FontWeight.w500, fontSize: 13)),
                              ),
                        ),
                        const SizedBox(height: 12),
                        _buildOtpHelpCard(),
                        const SizedBox(height: 28),
                        _buildButton('Verify & Login', _verifyOtp),
                        const SizedBox(height: 12),
                        Center(
                          child: GestureDetector(
                            onTap: () async => _resetOtpFlow(),
                            child: Text('← Change Number', style: GoogleFonts.poppins(
                              color: const Color(0xFF94A3B8), fontWeight: FontWeight.w500, fontSize: 13)),
                          ),
                        ),
                      ],

                      const SizedBox(height: 28),
                      Row(children: [
                        const Expanded(child: Divider(color: Color(0xFFF1F5F9), thickness: 1.5)),
                        Padding(padding: const EdgeInsets.symmetric(horizontal: 14),
                          child: Text('or', style: GoogleFonts.poppins(color: const Color(0xFFCBD5E1), fontSize: 13))),
                        const Expanded(child: Divider(color: Color(0xFFF1F5F9), thickness: 1.5)),
                      ]),
                      const SizedBox(height: 20),
                      Row(mainAxisAlignment: MainAxisAlignment.center, children: [
                        Text("New pilot?  ", style: GoogleFonts.poppins(color: const Color(0xFF94A3B8), fontSize: 14)),
                        GestureDetector(
                          onTap: () => Navigator.push(context, MaterialPageRoute(builder: (_) => const RegisterScreen())),
                          child: Text('Register Now', style: GoogleFonts.poppins(color: _blue, fontWeight: FontWeight.w400, fontSize: 14)),
                        ),
                      ]),
                    ]),
                  ),
                ),
              ),
            ),
          ],
        ),
        ),  // Theme
      ),
    );
  }

  Widget _buildPhoneField() {
    return Container(
      decoration: BoxDecoration(
        color: Colors.white,
        borderRadius: BorderRadius.circular(16),
        border: Border.all(color: _blue.withValues(alpha: 0.3), width: 1.5),
        boxShadow: [
          BoxShadow(
            color: _blue.withValues(alpha: 0.06),
            blurRadius: 8,
            offset: const Offset(0, 2),
          ),
        ],
      ),
      child: Row(children: [
        Container(
          padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 18),
          decoration: BoxDecoration(
            color: _blue.withValues(alpha: 0.08),
            borderRadius: const BorderRadius.only(
              topLeft: Radius.circular(14),
              bottomLeft: Radius.circular(14),
            ),
            border: Border(right: BorderSide(color: _blue.withValues(alpha: 0.2), width: 1.5)),
          ),
          child: Text('+91', style: GoogleFonts.poppins(fontSize: 16, fontWeight: FontWeight.w400, color: _blue)),
        ),
        Expanded(
          child: TextField(
            controller: _phoneCtrl,
            keyboardType: TextInputType.phone,
            inputFormatters: [FilteringTextInputFormatter.digitsOnly, LengthLimitingTextInputFormatter(10)],
            style: GoogleFonts.poppins(fontSize: 16, fontWeight: FontWeight.w400, color: _dark),
            decoration: InputDecoration(
              hintText: 'Mobile number',
              hintStyle: GoogleFonts.poppins(fontSize: 14, color: const Color(0xFFCBD5E1)),
              border: InputBorder.none,
              contentPadding: const EdgeInsets.symmetric(horizontal: 16, vertical: 18),
            ),
          ),
        ),
      ]),
    );
  }

  Widget _buildPasswordField() {
    return Container(
      decoration: BoxDecoration(
        color: const Color(0xFFF8FAFC),
        borderRadius: BorderRadius.circular(16),
        border: Border.all(color: const Color(0xFFE2E8F0), width: 1.5),
      ),
      child: TextField(
        controller: _passwordCtrl,
        obscureText: !_showPassword,
        style: GoogleFonts.poppins(fontSize: 16, fontWeight: FontWeight.w400, color: _dark),
        decoration: InputDecoration(
          hintText: 'Password',
          hintStyle: GoogleFonts.poppins(fontSize: 14, color: const Color(0xFFCBD5E1)),
          border: InputBorder.none,
          contentPadding: const EdgeInsets.symmetric(horizontal: 16, vertical: 18),
          prefixIcon: const Icon(Icons.lock_outline_rounded, color: Color(0xFFCBD5E1), size: 20),
          suffixIcon: IconButton(
            icon: Icon(_showPassword ? Icons.visibility_off_outlined : Icons.visibility_outlined,
              color: const Color(0xFFCBD5E1), size: 20),
            onPressed: () => setState(() => _showPassword = !_showPassword),
          ),
        ),
      ),
    );
  }

  Widget _buildOtpField() {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 4),
      decoration: BoxDecoration(
        color: const Color(0xFFF8FAFC),
        borderRadius: BorderRadius.circular(16),
        border: Border.all(color: _blue.withValues(alpha: 0.4), width: 2),
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
        style: GoogleFonts.poppins(
          fontSize: 28, fontWeight: FontWeight.w500,
          letterSpacing: 16, color: _dark,
        ),
        decoration: InputDecoration(
          counterText: '',
          border: InputBorder.none,
          hintText: '• • • • • •',
          hintStyle: GoogleFonts.poppins(
            fontSize: 20, color: const Color(0xFFCBD5E1), letterSpacing: 12,
          ),
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
      height: 58,
      child: ElevatedButton(
        onPressed: _loading ? null : onTap,
        style: ElevatedButton.styleFrom(
          backgroundColor: _loading ? _blue.withValues(alpha: 0.4) : _blue,
          foregroundColor: Colors.white,
          elevation: _loading ? 0 : 6,
          shadowColor: _blue.withValues(alpha: 0.4),
          shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(18)),
        ),
        child: _loading
          ? const SizedBox(width: 22, height: 22, child: CircularProgressIndicator(color: Colors.white, strokeWidth: 2.5))
          : Text(label, style: GoogleFonts.poppins(fontSize: 16, fontWeight: FontWeight.w400, color: Colors.white, letterSpacing: 0.3)),
      ),
    );
  }
}
