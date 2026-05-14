import 'dart:async';

import 'package:firebase_core/firebase_core.dart';
import 'package:firebase_auth/firebase_auth.dart';

/// Wraps Firebase Phone Authentication for driver app.
class FirebaseOtpService {
  static final FirebaseAuth _auth = FirebaseAuth.instance;

  static String? _verificationId;
  static int? _resendToken;

  static String _mapAuthError(FirebaseAuthException e) {
    switch (e.code) {
      case 'invalid-phone-number':
        return 'Invalid phone number format.';
      case 'too-many-requests':
        return 'Too many attempts. Please wait a bit before trying again.';
      case 'quota-exceeded':
        return 'OTP quota exceeded. Please try again later.';
      case 'app-not-authorized':
        return 'Firebase phone auth is not authorized for this app build.';
      case 'session-expired':
        return 'This OTP session expired. Please resend OTP and try again.';
      case 'invalid-verification-code':
        return 'Incorrect OTP. Please check the code and try again.';
      case 'network-request-failed':
        return 'Network issue while contacting Firebase. Check your connection and try again.';
      case 'internal-error':
        return 'Firebase phone auth internal error. This usually means the app build is not fully configured in Firebase Console (SHA keys / Play Integrity / Phone Auth).';
      default:
        return e.message ?? 'Failed to process OTP. Please try again.';
    }
  }

  static Future<void> _ensureFirebaseReady() async {
    if (Firebase.apps.isNotEmpty) return;
    await Firebase.initializeApp();
  }

  static Future<void> resetVerification() async {
    _verificationId = null;
    _resendToken = null;
    try {
      await _auth.signOut();
    } catch (_) {}
  }

  static Future<void> sendOtp({
    required String phoneNumber,
    required void Function(String verificationId) onCodeSent,
    required void Function(String error) onError,
    void Function(String idToken)? onAutoVerify,
    bool forceResend = false,
  }) async {
    final completer = Completer<void>();
    Timer? watchdog;
    var callbackHandled = false;

    void finish() {
      callbackHandled = true;
      watchdog?.cancel();
      if (!completer.isCompleted) completer.complete();
    }

    try {
      await _ensureFirebaseReady();
      if (!forceResend) {
        _verificationId = null;
      }
      await _auth.verifyPhoneNumber(
        phoneNumber: phoneNumber,
        forceResendingToken: forceResend ? _resendToken : null,
        timeout: const Duration(seconds: 60),
        verificationCompleted: (PhoneAuthCredential credential) async {
          // Auto-retrieval disabled — user must always enter OTP manually.
          // signInWithCredential here would consume the session and cause
          // "session expired" when user tries to verify manually.
          if (onAutoVerify == null) return;
          try {
            final userCred = await _auth.signInWithCredential(credential);
            final idToken = await userCred.user?.getIdToken(true);
            if (idToken != null) onAutoVerify.call(idToken);
          } catch (_) {}
        },
        verificationFailed: (FirebaseAuthException e) {
          _verificationId = null;
          onError(_mapAuthError(e));
          finish();
        },
        codeSent: (String verificationId, int? resendToken) {
          _verificationId = verificationId;
          _resendToken = resendToken;
          onCodeSent(verificationId);
          finish();
        },
        codeAutoRetrievalTimeout: (String verificationId) {
          _verificationId = verificationId;
        },
      );
      watchdog = Timer(const Duration(seconds: 55), () {
        if (callbackHandled) return;
        onError('OTP request timed out. Please tap Resend OTP to try again.');
        finish();
      });
      await completer.future;
    } catch (e) {
      onError('Failed to send OTP: ${e.toString()}');
    }
  }

  static Future<String> verifyOtp({
    required String smsCode,
    String? verificationId,
  }) async {
    await _ensureFirebaseReady();
    final vId = verificationId ?? _verificationId;
    if (vId == null) throw Exception('Verification ID missing. Please resend OTP.');

    // Sign out any stale session before creating a new one — prevents "session expired"
    try { await _auth.signOut(); } catch (_) {}

    final credential = PhoneAuthProvider.credential(
      verificationId: vId,
      smsCode: smsCode,
    );
    try {
      final userCred = await _auth.signInWithCredential(credential);
      final idToken = await userCred.user?.getIdToken(true);
      if (idToken == null) throw Exception('Could not get Firebase token. Please try again.');
      return idToken;
    } on FirebaseAuthException catch (e) {
      throw Exception(_mapAuthError(e));
    }
  }

  static Future<void> signOut() async {
    try { await _auth.signOut(); } catch (_) {}
  }
}
