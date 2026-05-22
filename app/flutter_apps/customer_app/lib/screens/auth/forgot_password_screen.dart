import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import '../../config/jago_theme.dart';
import '../../services/auth_service.dart';

class ForgotPasswordScreen extends StatefulWidget {
  const ForgotPasswordScreen({super.key});

  @override
  State<ForgotPasswordScreen> createState() => _ForgotPasswordScreenState();
}

class _ForgotPasswordScreenState extends State<ForgotPasswordScreen> {
  final _phoneCtrl = TextEditingController();
  bool _loading = false;
  bool _submitted = false;
  String _message =
      'Enter your registered mobile number. OTP reset is disabled in production. Support will verify ownership before changing the password.';

  static const Color _blue = Color(0xFF2F7BFF);

  @override
  void dispose() {
    _phoneCtrl.dispose();
    super.dispose();
  }

  void _showSnack(String msg, {bool error = false}) {
    if (!mounted) return;
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(
        content: Text(msg, style: const TextStyle(fontWeight: FontWeight.w400)),
        backgroundColor: error ? const Color(0xFFE53935) : _blue,
        behavior: SnackBarBehavior.floating,
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12)),
      ),
    );
  }

  Future<void> _submitResetRequest() async {
    final phone = _phoneCtrl.text.trim();
    if (phone.length != 10) {
      _showSnack('Enter a valid 10-digit phone number', error: true);
      return;
    }

    setState(() => _loading = true);
    final res = await AuthService.forgotPassword(phone);
    if (!mounted) return;
    setState(() => _loading = false);

    if (res['success'] == true) {
      setState(() {
        _submitted = true;
        _message = (res['message']?.toString().trim().isNotEmpty ?? false)
            ? res['message'].toString()
            : 'Password reset request received. Support will verify ownership before resetting the password.';
      });
      _showSnack('Support reset request submitted');
      return;
    }

    _showSnack(
      res['message']?.toString() ?? 'Unable to submit reset request.',
      error: true,
    );
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
          leading: IconButton(
            icon: const Icon(
              Icons.arrow_back_ios_new_rounded,
              color: Color(0xFF1A1A2E),
            ),
            onPressed: () => Navigator.pop(context),
          ),
          title: const Text(
            'Forgot Password',
            style: TextStyle(
              color: Color(0xFF1A1A2E),
              fontWeight: FontWeight.w500,
            ),
          ),
        ),
        body: SingleChildScrollView(
          padding: const EdgeInsets.all(24),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              const Icon(Icons.support_agent_rounded, size: 56, color: JT.primary),
              const SizedBox(height: 16),
              Text(
                _submitted ? 'Support Request Submitted' : 'Support-Assisted Reset',
                style: TextStyle(
                  fontSize: 22,
                  fontWeight: FontWeight.w400,
                  color: Colors.grey[900],
                ),
              ),
              const SizedBox(height: 8),
              Text(
                _message,
                style: TextStyle(color: Colors.grey[500], fontSize: 14),
              ),
              const SizedBox(height: 32),
              Text(
                'Phone Number',
                style: TextStyle(
                  fontSize: 13,
                  fontWeight: FontWeight.w500,
                  color: Colors.grey[700],
                ),
              ),
              const SizedBox(height: 8),
              Container(
                decoration: BoxDecoration(
                  color: const Color(0xFFF5F7FA),
                  borderRadius: BorderRadius.circular(14),
                ),
                child: Row(
                  children: [
                    const Padding(
                      padding: EdgeInsets.symmetric(horizontal: 16),
                      child: Text(
                        '+91',
                        style: TextStyle(fontSize: 15, fontWeight: FontWeight.w500),
                      ),
                    ),
                    Container(width: 1, height: 24, color: Colors.grey[300]),
                    Expanded(
                      child: TextField(
                        controller: _phoneCtrl,
                        enabled: !_submitted,
                        keyboardType: TextInputType.phone,
                        inputFormatters: [
                          FilteringTextInputFormatter.digitsOnly,
                          LengthLimitingTextInputFormatter(10),
                        ],
                        style: const TextStyle(
                          fontSize: 15,
                          fontWeight: FontWeight.w400,
                        ),
                        decoration: const InputDecoration(
                          hintText: 'Enter 10-digit number',
                          border: InputBorder.none,
                          contentPadding:
                              EdgeInsets.symmetric(horizontal: 16, vertical: 16),
                        ),
                      ),
                    ),
                  ],
                ),
              ),
              const SizedBox(height: 32),
              SizedBox(
                width: double.infinity,
                height: 56,
                child: ElevatedButton(
                  onPressed: _loading || _submitted ? null : _submitResetRequest,
                  style: ElevatedButton.styleFrom(
                    backgroundColor: _blue,
                    foregroundColor: Colors.white,
                    shape: RoundedRectangleBorder(
                      borderRadius: BorderRadius.circular(16),
                    ),
                    elevation: 0,
                  ),
                  child: _loading
                      ? const SizedBox(
                          width: 22,
                          height: 22,
                          child: CircularProgressIndicator(
                            color: Colors.white,
                            strokeWidth: 2.5,
                          ),
                        )
                      : Text(
                          _submitted ? 'Request Submitted' : 'Request Password Reset',
                          style: const TextStyle(
                            fontSize: 17,
                            fontWeight: FontWeight.w400,
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
}
