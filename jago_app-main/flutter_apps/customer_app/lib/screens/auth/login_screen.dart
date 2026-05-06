import 'dart:async';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:google_fonts/google_fonts.dart';
import 'package:sms_autofill/sms_autofill.dart';
import '../../config/jago_theme.dart';
import '../../services/auth_service.dart';
import '../../services/firebase_otp_service.dart';
import '../home/home_screen.dart';
import '../main_screen.dart';
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
  final _phoneFocus = FocusNode();

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
    _phoneFocus.dispose();
    super.dispose();
  }

  void _snack(String msg, {bool error = false}) {
    if (!mounted) return;
    ScaffoldMessenger.of(context).clearSnackBars();
    ScaffoldMessenger.of(context).showSnackBar(SnackBar(
      content: Text(msg, style: GoogleFonts.poppins(fontWeight: FontWeight.w400, color: Colors.white, fontSize: 13)),
      backgroundColor: error ? JT.error : JT.success,
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
            child: Text('OK', style: GoogleFonts.poppins(fontWeight: FontWeight.w500, color: JT.primary)),
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
      return 'This OTP expired. Please resend and use the latest code.';
    }
    if (lower.contains('cooldown') || lower.contains('wait')) {
      return 'Please wait a few seconds before requesting another OTP.';
    }
    return text.isNotEmpty ? text : 'Please check the latest OTP and try again.';
  }

  Future<bool> _sendServerOtpFallback(String phone, {String? preferredMessage}) async {
    final res = await AuthService.sendOtp(phone, 'customer', true);
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
              color: JT.primary.withValues(alpha: 0.08),
              borderRadius: BorderRadius.circular(10),
            ),
            child: Icon(
              isFirebase ? Icons.shield_outlined : Icons.sms_outlined,
              color: JT.primary,
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
                    color: JT.textPrimary,
                  ),
                ),
                const SizedBox(height: 3),
                Text(
                  message,
                  style: GoogleFonts.poppins(
                    fontSize: 11.5,
                    fontWeight: FontWeight.w400,
                    color: JT.textSecondary,
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
      // No auto-verify — passing a callback would make firebase_otp_service
      // consume the PhoneAuthCredential inside verificationCompleted. If the
      // network call after consumption then fails (or the user is already
      // typing manually), the next manual verifyOtp throws "session expired".
      // SMS still auto-fills the OTP TextField via the CodeAutoFill mixin
      // below, so the user-visible UX stays the same.
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
        final res = await AuthService.verifyFirebaseToken(idToken, phone, 'customer');
        if (!mounted) return;
        _otpVerifyCompleted = true;
        setState(() => _loading = false);
        if (res['success'] == true || res['token'] != null) {
          Navigator.pushAndRemoveUntil(context, MaterialPageRoute(builder: (_) => const MainScreen()), (_) => false);
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
        final fallback = await AuthService.sendOtp(phone, 'customer', true);
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

    try {
      final res = await AuthService.verifyOtp(phone, otp, 'customer');
      if (!mounted) return;
      _otpVerifyCompleted = true;
      setState(() => _loading = false);
      if (res['success'] == true || res['token'] != null) {
        Navigator.pushAndRemoveUntil(context, MaterialPageRoute(builder: (_) => const MainScreen()), (_) => false);
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
      Navigator.pushAndRemoveUntil(context, MaterialPageRoute(builder: (_) => const MainScreen()), (_) => false);
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
        backgroundColor: JT.bg,
        resizeToAvoidBottomInset: true,
        body: Stack(
          children: [
            // Soft blue backdrop
            Positioned.fill(
              child: Container(
                color: const Color(0xFFF7FAFF),
              ),
            ),

            // Top brand area
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
                          borderRadius: BorderRadius.circular(24),
                          color: Colors.white,
                          border: Border.all(color: const Color(0xFFD8E6F8)),
                          boxShadow: [
                            BoxShadow(
                              color: JT.primary.withValues(alpha: 0.08),
                              blurRadius: 20,
                              offset: const Offset(0, 8),
                            ),
                          ],
                        ),
                        child: Padding(
                          padding: const EdgeInsets.all(10),
                          child: JT.logoBlue(height: 44),
                        ),
                      ),
                      const SizedBox(height: 18),
                      JT.logoBlue(height: 36),
                      const SizedBox(height: 6),
                      Text('Your ride, your way', style: GoogleFonts.poppins(
                        fontSize: 12, fontWeight: FontWeight.w400,
                        color: JT.textSecondary,
                        letterSpacing: 0.5,
                      )),
                    ],
                  ),
                ),
              ),
            ),

            // Bottom white card
            Positioned(
              bottom: 0, left: 0, right: 0,
              child: SlideTransition(
                position: _cardSlide,
                child: Container(
                  constraints: BoxConstraints(maxHeight: size.height * 0.64),
                  decoration: BoxDecoration(
                    color: Colors.white,
                    borderRadius: BorderRadius.vertical(top: Radius.circular(32)),
                    boxShadow: [
                      BoxShadow(
                        color: Colors.black.withValues(alpha: 0.05),
                        blurRadius: 24,
                        offset: const Offset(0, -6),
                      ),
                    ],
                  ),
                  child: SingleChildScrollView(
                    padding: EdgeInsets.only(
                      left: 28, right: 28, top: 8,
                      bottom: MediaQuery.of(context).viewInsets.bottom + 32,
                    ),
                    child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                      // Drag handle
                      Center(child: Container(
                        margin: const EdgeInsets.only(top: 12, bottom: 24),
                        width: 36, height: 4,
                        decoration: BoxDecoration(
                          color: JT.border,
                          borderRadius: BorderRadius.circular(2),
                        ),
                      )),

                      // Title
                      Text(
                        _otpSent ? 'Enter OTP' : (_usePassword ? 'Welcome Back' : 'Sign In'),
                        style: GoogleFonts.poppins(
                          fontSize: 26, fontWeight: FontWeight.w400, color: JT.textPrimary,
                        ),
                      ),
                      const SizedBox(height: 4),
                      Text(
                        _otpSent
                          ? 'Sent to +91 ${_phoneCtrl.text}'
                          : (_usePassword ? 'Login with your password' : 'Enter your mobile number'),
                        style: GoogleFonts.poppins(
                          fontSize: 13, color: JT.textSecondary,
                        ),
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
                              child: Text('Forgot Password?', style: GoogleFonts.poppins(
                                color: JT.primary, fontWeight: FontWeight.w400, fontSize: 13,
                              )),
                            ),
                          ),
                        ],
                        const SizedBox(height: 24),
                        _buildButton(_usePassword ? 'Login' : 'Get OTP',
                          _usePassword ? _loginWithPassword : _sendOtp),
                        const SizedBox(height: 16),
                        Center(
                          child: GestureDetector(
                            onTap: () => setState(() { _usePassword = !_usePassword; }),
                            child: Text(
                              _usePassword ? 'Use OTP instead' : 'Use Password instead',
                              style: GoogleFonts.poppins(color: JT.primary, fontWeight: FontWeight.w400, fontSize: 13),
                            ),
                          ),
                        ),
                      ] else ...[
                        _buildOtpField(),
                        const SizedBox(height: 12),
                        Center(
                          child: _seconds > 0
                            ? Text('Resend in ${_seconds}s', style: GoogleFonts.poppins(
                                color: JT.textSecondary, fontSize: 13))
                            : GestureDetector(
                                onTap: () async { await _resetOtpFlow(); await _sendOtp(); },
                                child: Text('Resend OTP', style: GoogleFonts.poppins(
                                  color: JT.primary, fontWeight: FontWeight.w500, fontSize: 13)),
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
                              color: JT.textSecondary, fontWeight: FontWeight.w500, fontSize: 13)),
                          ),
                        ),
                      ],

                      const SizedBox(height: 28),
                      Row(children: [
                        Expanded(child: Divider(color: JT.border, thickness: 1.5)),
                        Padding(
                          padding: const EdgeInsets.symmetric(horizontal: 14),
                          child: Text('or', style: GoogleFonts.poppins(color: JT.iconInactive, fontSize: 13)),
                        ),
                        Expanded(child: Divider(color: JT.border, thickness: 1.5)),
                      ]),
                      const SizedBox(height: 20),
                      Row(mainAxisAlignment: MainAxisAlignment.center, children: [
                        Text("Don't have an account?  ", style: GoogleFonts.poppins(
                          color: JT.textSecondary, fontSize: 14)),
                        GestureDetector(
                          onTap: () => Navigator.push(context, MaterialPageRoute(builder: (_) => const RegisterScreen())),
                          child: Text('Create Account', style: GoogleFonts.poppins(
                            color: JT.primary, fontWeight: FontWeight.w400, fontSize: 14)),
                        ),
                      ]),
                    ]),
                  ),
                ),
              ),
            ),
          ],
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
        boxShadow: [
          BoxShadow(
            color: Colors.black.withValues(alpha: 0.04),
            blurRadius: 12,
            offset: const Offset(0, 2),
          ),
        ],
      ),
      child: Row(children: [
        Container(
          padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 18),
          decoration: BoxDecoration(
            color: const Color(0xFFF2F7FF),
            borderRadius: const BorderRadius.only(
              topLeft: Radius.circular(14),
              bottomLeft: Radius.circular(14),
            ),
            border: const Border(right: BorderSide(color: Color(0xFFD8E6F8), width: 1.2)),
          ),
          child: Text('+91', style: GoogleFonts.poppins(
            fontSize: 16, fontWeight: FontWeight.w400, color: JT.primary)),
        ),
        Expanded(
          child: TextField(
            controller: _phoneCtrl,
            focusNode: _phoneFocus,
            keyboardType: TextInputType.phone,
            inputFormatters: [FilteringTextInputFormatter.digitsOnly, LengthLimitingTextInputFormatter(10)],
            style: GoogleFonts.poppins(fontSize: 16, fontWeight: FontWeight.w400, color: JT.textPrimary),
            decoration: InputDecoration(
              hintText: 'Mobile number',
              hintStyle: GoogleFonts.poppins(fontSize: 14, color: JT.iconInactive),
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
        color: Colors.white,
        borderRadius: BorderRadius.circular(16),
        border: Border.all(color: const Color(0xFFD8E6F8), width: 1.2),
      ),
      child: TextField(
        controller: _passwordCtrl,
        obscureText: !_showPassword,
        style: GoogleFonts.poppins(fontSize: 16, fontWeight: FontWeight.w400, color: JT.textPrimary),
        decoration: InputDecoration(
          hintText: 'Password',
          hintStyle: GoogleFonts.poppins(fontSize: 14, color: JT.iconInactive),
          border: InputBorder.none,
          contentPadding: const EdgeInsets.symmetric(horizontal: 16, vertical: 18),
          prefixIcon: const Icon(Icons.lock_outline_rounded, color: JT.iconInactive, size: 20),
          suffixIcon: IconButton(
            icon: Icon(_showPassword ? Icons.visibility_off_outlined : Icons.visibility_outlined,
              color: JT.iconInactive, size: 20),
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
        style: GoogleFonts.poppins(
          fontSize: 28, fontWeight: FontWeight.w500,
          letterSpacing: 16, color: JT.textPrimary,
        ),
        decoration: InputDecoration(
          counterText: '',
          border: InputBorder.none,
          hintText: '• • • • • •',
          hintStyle: GoogleFonts.poppins(
            fontSize: 20, color: JT.iconInactive, letterSpacing: 12,
          ),
        ),
        onChanged: (code) {
          if (code.length == 6) _verifyOtp();
        },
      ),
    );
  }

  Widget _buildButton(String label, VoidCallback onTap) {
    return JT.gradientButton(label: label, onTap: onTap, loading: _loading);
  }
}
