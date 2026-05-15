import 'dart:async';
import 'package:flutter/material.dart';
import '../../config/jago_theme.dart';
import 'package:flutter/services.dart';
import '../../services/auth_service.dart';
import '../../services/firebase_otp_service.dart';
import 'login_screen.dart';

class ForgotPasswordScreen extends StatefulWidget {
  const ForgotPasswordScreen({super.key});
  @override
  State<ForgotPasswordScreen> createState() => _ForgotPasswordScreenState();
}

class _ForgotPasswordScreenState extends State<ForgotPasswordScreen> {
  final _phoneCtrl = TextEditingController();
  final _otpCtrl = TextEditingController();
  final _newPassCtrl = TextEditingController();
  final _confirmCtrl = TextEditingController();
  bool _loading = false;
  bool _showNewPass = false;
  bool _showConfirm = false;
  int _step = 0;
  String? _firebaseVerificationId;
  String? _firebaseIdToken;
  int _seconds = 0;
  Timer? _timer;

  static const Color _blue = Color(0xFF2F7BFF);

  @override
  void dispose() {
    _timer?.cancel();
    FirebaseOtpService.resetVerification();
    _phoneCtrl.dispose();
    _otpCtrl.dispose();
    _newPassCtrl.dispose();
    _confirmCtrl.dispose();
    super.dispose();
  }

  void _showSnack(String msg, {bool error = false}) {
    ScaffoldMessenger.of(context).showSnackBar(SnackBar(
      content: Text(msg, style: const TextStyle(fontWeight: FontWeight.w400)),
      backgroundColor: error ? const Color(0xFFE53935) : _blue,
      behavior: SnackBarBehavior.floating,
      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12)),
    ));
  }

  void _startTimer() {
    _timer?.cancel();
    _seconds = 30;
    _timer = Timer.periodic(const Duration(seconds: 1), (t) {
      if (!mounted || _seconds == 0) { t.cancel(); return; }
      setState(() => _seconds--);
    });
  }

  Future<void> _sendOtp() async {
    final phone = _phoneCtrl.text.trim();
    if (phone.length != 10) { _showSnack('Enter a valid 10-digit phone number', error: true); return; }
    setState(() => _loading = true);
    _firebaseVerificationId = null;
    _firebaseIdToken = null;
    await FirebaseOtpService.resetVerification();
    final precheck = await AuthService.forgotPassword(phone);
    if (!mounted) return;
    if (precheck['success'] != true) {
      setState(() => _loading = false);
      _showSnack(precheck['message'] ?? 'Unable to start password reset.', error: true);
      return;
    }
    bool firebaseSent = false;
    String? firebaseError;
    await FirebaseOtpService.sendOtp(
      phoneNumber: '+91$phone',
      onCodeSent: (vId) {
        _firebaseVerificationId = vId;
        firebaseSent = true;
      },
      onError: (err) {
        firebaseError = err;
      },
    );
    if (!mounted) return;
    if (firebaseSent) {
      setState(() { _loading = false; _step = 1; });
      _startTimer();
      _showSnack('OTP sent to +91$phone');
      return;
    }

    firebaseError ??= 'OTP send failed. Retrying once...';
    await FirebaseOtpService.sendOtp(
      phoneNumber: '+91$phone',
      forceResend: true,
      onCodeSent: (vId) {
        _firebaseVerificationId = vId;
        firebaseSent = true;
      },
      onError: (err) {
        firebaseError = err;
      },
    );
    if (!mounted) return;
    if (firebaseSent) {
      setState(() { _loading = false; _step = 1; });
      _startTimer();
      _showSnack('OTP sent to +91$phone');
      return;
    }
    setState(() => _loading = false);
    _showSnack(firebaseError ?? 'Failed to send OTP', error: true);
  }

  Future<void> _verifyOtpStep() async {
    final otp = _otpCtrl.text.trim();
    if (otp.length != 6) { _showSnack('Enter the 6-digit OTP', error: true); return; }
    if (_firebaseVerificationId == null) {
      _showSnack('OTP session expired. Please resend OTP.', error: true);
      return;
    }
    setState(() => _loading = true);
    try {
      final idToken = await FirebaseOtpService.verifyOtp(
          smsCode: otp, verificationId: _firebaseVerificationId);
      if (!mounted) return;
      _firebaseIdToken = idToken;
      if (!mounted) return;
      setState(() { _loading = false; _step = 2; });
    } catch (e) {
      if (!mounted) return;
      setState(() => _loading = false);
      _showSnack(e.toString().replaceAll('Exception: ', ''), error: true);
    }
  }

  Future<void> _resetPassword() async {
    final newPass = _newPassCtrl.text;
    final confirm = _confirmCtrl.text;
    if (newPass.length < 6) { _showSnack('Password must be at least 6 characters', error: true); return; }
    if (newPass != confirm) { _showSnack('Passwords do not match', error: true); return; }
    if (_firebaseIdToken == null) {
      _showSnack('Verification expired. Please restart.', error: true);
      return;
    }
    setState(() => _loading = true);
    final res = await AuthService.resetPasswordWithFirebase(
        _firebaseIdToken!, _phoneCtrl.text.trim(), newPass);
    if (!mounted) return;
    setState(() => _loading = false);
    if (res['success'] == true) {
      _showSnack('Password reset successfully!');
      await Future.delayed(const Duration(seconds: 1));
      if (!mounted) return;
      Navigator.pushAndRemoveUntil(context, MaterialPageRoute(builder: (_) => const LoginScreen()), (_) => false);
    } else {
      _showSnack(res['message'] ?? 'Reset failed. Try again.', error: true);
    }
  }

  @override
  Widget build(BuildContext context) {
    return AnnotatedRegion<SystemUiOverlayStyle>(
      value: SystemUiOverlayStyle.dark,
      child: Scaffold(
        backgroundColor: Colors.white,
        appBar: AppBar(
          backgroundColor: Colors.white, elevation: 0,
          leading: IconButton(icon: const Icon(Icons.arrow_back_ios_new_rounded, color: Color(0xFF1A1A2E)), onPressed: () => Navigator.pop(context)),
          title: const Text('Forgot Password', style: TextStyle(color: Color(0xFF1A1A2E), fontWeight: FontWeight.w500)),
        ),
        body: SingleChildScrollView(
          padding: const EdgeInsets.all(24),
          child: _step == 0 ? _buildStep0() : _step == 1 ? _buildStep1() : _buildStep2(),
        ),
      ),
    );
  }

  Widget _buildStep0() {
    return Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
      const Icon(Icons.lock_reset_rounded, size: 56, color: JT.primary),
      const SizedBox(height: 16),
      Text('Reset Your Password', style: TextStyle(fontSize: 22, fontWeight: FontWeight.w400, color: Colors.grey[900])),
      const SizedBox(height: 8),
      Text('Enter your registered phone number. We\'ll send you a 6-digit OTP.', style: TextStyle(color: Colors.grey[500], fontSize: 14)),
      const SizedBox(height: 32),
      Text('Phone Number', style: TextStyle(fontSize: 13, fontWeight: FontWeight.w500, color: Colors.grey[700])),
      const SizedBox(height: 8),
      Container(
        decoration: BoxDecoration(color: const Color(0xFFF5F7FA), borderRadius: BorderRadius.circular(14)),
        child: Row(children: [
          const Padding(padding: EdgeInsets.symmetric(horizontal: 16), child: Text('+91', style: TextStyle(fontSize: 15, fontWeight: FontWeight.w500))),
          Container(width: 1, height: 24, color: Colors.grey[300]),
          Expanded(child: TextField(
            controller: _phoneCtrl,
            keyboardType: TextInputType.phone,
            inputFormatters: [FilteringTextInputFormatter.digitsOnly, LengthLimitingTextInputFormatter(10)],
            style: const TextStyle(fontSize: 15, fontWeight: FontWeight.w400),
            decoration: const InputDecoration(hintText: 'Enter 10-digit number', border: InputBorder.none, contentPadding: EdgeInsets.symmetric(horizontal: 16, vertical: 16)),
          )),
        ]),
      ),
      const SizedBox(height: 32),
      SizedBox(
        width: double.infinity, height: 56,
        child: ElevatedButton(
          onPressed: _loading ? null : _sendOtp,
          style: ElevatedButton.styleFrom(backgroundColor: _blue, foregroundColor: Colors.white, shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(16)), elevation: 0),
          child: _loading ? const SizedBox(width: 22, height: 22, child: CircularProgressIndicator(color: Colors.white, strokeWidth: 2.5)) : const Text('Send Reset OTP', style: TextStyle(fontSize: 17, fontWeight: FontWeight.w400)),
        ),
      ),
    ]);
  }

  Widget _buildStep1() {
    return Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
      const Icon(Icons.sms_rounded, size: 56, color: JT.primary),
      const SizedBox(height: 16),
      Text('Enter OTP', style: TextStyle(fontSize: 22, fontWeight: FontWeight.w400, color: Colors.grey[900])),
      const SizedBox(height: 8),
      Text('OTP sent to +91${_phoneCtrl.text}', style: TextStyle(color: Colors.grey[500], fontSize: 13)),
      const SizedBox(height: 28),
      Text('6-Digit OTP', style: TextStyle(fontSize: 13, fontWeight: FontWeight.w500, color: Colors.grey[700])),
      const SizedBox(height: 8),
      Container(
        decoration: BoxDecoration(color: const Color(0xFFF5F7FA), borderRadius: BorderRadius.circular(14)),
        child: TextField(
          controller: _otpCtrl,
          keyboardType: TextInputType.number,
          inputFormatters: [FilteringTextInputFormatter.digitsOnly, LengthLimitingTextInputFormatter(6)],
          textAlign: TextAlign.center,
          style: const TextStyle(fontSize: 22, fontWeight: FontWeight.w400, letterSpacing: 8),
          decoration: const InputDecoration(hintText: '------', border: InputBorder.none, contentPadding: EdgeInsets.symmetric(vertical: 16)),
        ),
      ),
      if (_seconds > 0) ...[
        const SizedBox(height: 8),
        Center(child: Text('Resend in ${_seconds}s', style: TextStyle(color: Colors.grey[400], fontSize: 13))),
      ] else ...[
        const SizedBox(height: 8),
        Center(child: GestureDetector(onTap: _sendOtp, child: Text('Resend OTP', style: TextStyle(color: _blue, fontWeight: FontWeight.w500, fontSize: 13)))),
      ],
      const SizedBox(height: 32),
      SizedBox(
        width: double.infinity, height: 56,
        child: ElevatedButton(
          onPressed: _loading ? null : _verifyOtpStep,
          style: ElevatedButton.styleFrom(backgroundColor: _blue, foregroundColor: Colors.white, shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(16)), elevation: 0),
          child: _loading ? const SizedBox(width: 22, height: 22, child: CircularProgressIndicator(color: Colors.white, strokeWidth: 2.5)) : const Text('Verify OTP', style: TextStyle(fontSize: 17, fontWeight: FontWeight.w400)),
        ),
      ),
    ]);
  }

  Widget _buildStep2() {
    return Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
      const Icon(Icons.lock_reset_rounded, size: 56, color: JT.primary),
      const SizedBox(height: 16),
      Text('Set New Password', style: TextStyle(fontSize: 22, fontWeight: FontWeight.w400, color: Colors.grey[900])),
      const SizedBox(height: 8),
      Text('Phone verified. Set your new password.', style: TextStyle(color: Colors.grey[500], fontSize: 13)),
      const SizedBox(height: 28),
      Text('New Password', style: TextStyle(fontSize: 13, fontWeight: FontWeight.w500, color: Colors.grey[700])),
      const SizedBox(height: 8),
      Container(
        decoration: BoxDecoration(color: const Color(0xFFF5F7FA), borderRadius: BorderRadius.circular(14)),
        child: TextField(
          controller: _newPassCtrl,
          obscureText: !_showNewPass,
          style: const TextStyle(fontSize: 15, fontWeight: FontWeight.w400),
          decoration: InputDecoration(
            hintText: 'Create new password',
            border: InputBorder.none,
            contentPadding: const EdgeInsets.symmetric(horizontal: 16, vertical: 16),
            prefixIcon: Icon(Icons.lock_outline_rounded, color: Colors.grey[400]),
            suffixIcon: IconButton(icon: Icon(_showNewPass ? Icons.visibility_off_outlined : Icons.visibility_outlined, color: Colors.grey[400]), onPressed: () => setState(() => _showNewPass = !_showNewPass)),
          ),
        ),
      ),
      const SizedBox(height: 16),
      Text('Confirm Password', style: TextStyle(fontSize: 13, fontWeight: FontWeight.w500, color: Colors.grey[700])),
      const SizedBox(height: 8),
      Container(
        decoration: BoxDecoration(color: const Color(0xFFF5F7FA), borderRadius: BorderRadius.circular(14)),
        child: TextField(
          controller: _confirmCtrl,
          obscureText: !_showConfirm,
          style: const TextStyle(fontSize: 15, fontWeight: FontWeight.w400),
          decoration: InputDecoration(
            hintText: 'Re-enter new password',
            border: InputBorder.none,
            contentPadding: const EdgeInsets.symmetric(horizontal: 16, vertical: 16),
            prefixIcon: Icon(Icons.lock_outline_rounded, color: Colors.grey[400]),
            suffixIcon: IconButton(icon: Icon(_showConfirm ? Icons.visibility_off_outlined : Icons.visibility_outlined, color: Colors.grey[400]), onPressed: () => setState(() => _showConfirm = !_showConfirm)),
          ),
        ),
      ),
      const SizedBox(height: 32),
      SizedBox(
        width: double.infinity, height: 56,
        child: ElevatedButton(
          onPressed: _loading ? null : _resetPassword,
          style: ElevatedButton.styleFrom(backgroundColor: _blue, foregroundColor: Colors.white, shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(16)), elevation: 0),
          child: _loading ? const SizedBox(width: 22, height: 22, child: CircularProgressIndicator(color: Colors.white, strokeWidth: 2.5)) : const Text('Reset Password', style: TextStyle(fontSize: 17, fontWeight: FontWeight.w400)),
        ),
      ),
    ]);
  }
}
