import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:google_fonts/google_fonts.dart';
import '../../config/jago_theme.dart';
import '../../services/auth_service.dart';
import '../main_screen.dart';
import 'forgot_password_screen.dart';
import 'register_screen.dart';

class LoginScreen extends StatefulWidget {
  const LoginScreen({super.key});

  @override
  State<LoginScreen> createState() => _LoginScreenState();
}

class _LoginScreenState extends State<LoginScreen>
    with TickerProviderStateMixin {
  final _phoneCtrl = TextEditingController();
  final _passwordCtrl = TextEditingController();
  final _phoneFocus = FocusNode();

  bool _loading = false;
  bool _showPassword = false;

  late AnimationController _cardCtrl;
  late Animation<Offset> _cardSlide;
  late AnimationController _logoCtrl;
  late Animation<double> _logoFade;

  @override
  void initState() {
    super.initState();
    _cardCtrl = AnimationController(
      vsync: this,
      duration: const Duration(milliseconds: 700),
    );
    _cardSlide = Tween<Offset>(begin: const Offset(0, 1), end: Offset.zero)
        .animate(
      CurvedAnimation(parent: _cardCtrl, curve: Curves.easeOutCubic),
    );
    _logoCtrl = AnimationController(
      vsync: this,
      duration: const Duration(milliseconds: 600),
    );
    _logoFade = Tween<double>(begin: 0, end: 1).animate(
      CurvedAnimation(parent: _logoCtrl, curve: Curves.easeOut),
    );
    _logoCtrl.forward();
    Future.delayed(const Duration(milliseconds: 200), () {
      if (mounted) {
        _cardCtrl.forward();
      }
    });
  }

  @override
  void dispose() {
    _cardCtrl.dispose();
    _logoCtrl.dispose();
    _phoneCtrl.dispose();
    _passwordCtrl.dispose();
    _phoneFocus.dispose();
    super.dispose();
  }

  void _snack(String msg, {bool error = false}) {
    if (!mounted) return;
    ScaffoldMessenger.of(context).clearSnackBars();
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(
        content: Text(
          msg,
          style: GoogleFonts.poppins(
            fontWeight: FontWeight.w400,
            color: Colors.white,
            fontSize: 13,
          ),
        ),
        backgroundColor: error ? JT.error : JT.success,
        behavior: SnackBarBehavior.floating,
        margin: const EdgeInsets.fromLTRB(16, 0, 16, 16),
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12)),
        duration: const Duration(seconds: 3),
      ),
    );
  }

  Future<void> _loginWithPassword() async {
    final phone = _phoneCtrl.text.trim();
    final pass = _passwordCtrl.text;
    if (phone.length != 10) {
      _snack('Enter a valid 10-digit mobile number', error: true);
      return;
    }
    if (pass.length < 8) {
      _snack('Password must be at least 8 characters', error: true);
      return;
    }
    setState(() => _loading = true);
    final res = await AuthService.loginWithPassword(phone, pass);
    if (!mounted) return;
    setState(() => _loading = false);
    if (res['success'] == true || res['token'] != null) {
      Navigator.pushAndRemoveUntil(
        context,
        MaterialPageRoute(builder: (_) => const MainScreen()),
        (_) => false,
      );
    } else {
      _snack(res['message']?.toString() ?? 'Login failed', error: true);
    }
  }

  @override
  Widget build(BuildContext context) {
    final size = MediaQuery.of(context).size;

    return AnnotatedRegion<SystemUiOverlayStyle>(
      value: const SystemUiOverlayStyle(
        statusBarColor: Colors.transparent,
        statusBarIconBrightness: Brightness.dark,
      ),
      child: Scaffold(
        backgroundColor: JT.bg,
        resizeToAvoidBottomInset: true,
        body: Stack(
          children: [
            Positioned.fill(
              child: Container(color: const Color(0xFFF7FAFF)),
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
                      Text(
                        'Secure password sign in only',
                        style: GoogleFonts.poppins(
                          fontSize: 12,
                          fontWeight: FontWeight.w400,
                          color: JT.textSecondary,
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
                  decoration: BoxDecoration(
                    color: Colors.white,
                    borderRadius:
                        const BorderRadius.vertical(top: Radius.circular(32)),
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
                              color: JT.border,
                              borderRadius: BorderRadius.circular(2),
                            ),
                          ),
                        ),
                        Text(
                          'Welcome Back',
                          style: GoogleFonts.poppins(
                            fontSize: 26,
                            fontWeight: FontWeight.w400,
                            color: JT.textPrimary,
                          ),
                        ),
                        const SizedBox(height: 4),
                        Text(
                          'OTP login has been removed. Use your mobile number and password.',
                          style: GoogleFonts.poppins(
                            fontSize: 13,
                            color: JT.textSecondary,
                          ),
                        ),
                        const SizedBox(height: 28),
                        _buildPhoneField(),
                        const SizedBox(height: 14),
                        _buildPasswordField(),
                        const SizedBox(height: 8),
                        Align(
                          alignment: Alignment.centerRight,
                          child: GestureDetector(
                            onTap: () => Navigator.push(
                              context,
                              MaterialPageRoute(
                                builder: (_) => const ForgotPasswordScreen(),
                              ),
                            ),
                            child: Text(
                              'Forgot Password?',
                              style: GoogleFonts.poppins(
                                color: JT.primary,
                                fontWeight: FontWeight.w400,
                                fontSize: 13,
                              ),
                            ),
                          ),
                        ),
                        const SizedBox(height: 24),
                        JT.gradientButton(
                          label: 'Login',
                          onTap: _loginWithPassword,
                          loading: _loading,
                        ),
                        const SizedBox(height: 28),
                        Row(
                          children: [
                            Expanded(
                              child: Divider(color: JT.border, thickness: 1.5),
                            ),
                            Padding(
                              padding:
                                  const EdgeInsets.symmetric(horizontal: 14),
                              child: Text(
                                'or',
                                style: GoogleFonts.poppins(
                                  color: JT.iconInactive,
                                  fontSize: 13,
                                ),
                              ),
                            ),
                            Expanded(
                              child: Divider(color: JT.border, thickness: 1.5),
                            ),
                          ],
                        ),
                        const SizedBox(height: 20),
                        Row(
                          mainAxisAlignment: MainAxisAlignment.center,
                          children: [
                            Text(
                              "Don't have an account?  ",
                              style: GoogleFonts.poppins(
                                color: JT.textSecondary,
                                fontSize: 14,
                              ),
                            ),
                            GestureDetector(
                              onTap: () => Navigator.push(
                                context,
                                MaterialPageRoute(
                                  builder: (_) => const RegisterScreen(),
                                ),
                              ),
                              child: Text(
                                'Create Account',
                                style: GoogleFonts.poppins(
                                  color: JT.primary,
                                  fontWeight: FontWeight.w400,
                                  fontSize: 14,
                                ),
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
      child: Row(
        children: [
          Container(
            padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 18),
            decoration: BoxDecoration(
              color: const Color(0xFFF2F7FF),
              borderRadius: const BorderRadius.only(
                topLeft: Radius.circular(14),
                bottomLeft: Radius.circular(14),
              ),
              border: const Border(
                right: BorderSide(color: Color(0xFFD8E6F8), width: 1.2),
              ),
            ),
            child: Text(
              '+91',
              style: GoogleFonts.poppins(
                fontSize: 16,
                fontWeight: FontWeight.w400,
                color: JT.primary,
              ),
            ),
          ),
          Expanded(
            child: TextField(
              controller: _phoneCtrl,
              focusNode: _phoneFocus,
              keyboardType: TextInputType.phone,
              inputFormatters: [
                FilteringTextInputFormatter.digitsOnly,
                LengthLimitingTextInputFormatter(10),
              ],
              style: GoogleFonts.poppins(
                fontSize: 16,
                fontWeight: FontWeight.w400,
                color: JT.textPrimary,
              ),
              decoration: InputDecoration(
                hintText: 'Mobile number',
                hintStyle: GoogleFonts.poppins(
                  fontSize: 14,
                  color: JT.iconInactive,
                ),
                border: InputBorder.none,
                contentPadding:
                    const EdgeInsets.symmetric(horizontal: 16, vertical: 18),
              ),
            ),
          ),
        ],
      ),
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
        textInputAction: TextInputAction.done,
        onSubmitted: (_) => _loginWithPassword(),
        style: GoogleFonts.poppins(
          fontSize: 16,
          fontWeight: FontWeight.w400,
          color: JT.textPrimary,
        ),
        decoration: InputDecoration(
          hintText: 'Password',
          hintStyle: GoogleFonts.poppins(
            fontSize: 14,
            color: JT.iconInactive,
          ),
          border: InputBorder.none,
          contentPadding:
              const EdgeInsets.symmetric(horizontal: 16, vertical: 18),
          prefixIcon: const Icon(
            Icons.lock_outline_rounded,
            color: JT.iconInactive,
            size: 20,
          ),
          suffixIcon: IconButton(
            icon: Icon(
              _showPassword
                  ? Icons.visibility_off_outlined
                  : Icons.visibility_outlined,
              color: JT.iconInactive,
              size: 20,
            ),
            onPressed: () => setState(() => _showPassword = !_showPassword),
          ),
        ),
      ),
    );
  }
}
