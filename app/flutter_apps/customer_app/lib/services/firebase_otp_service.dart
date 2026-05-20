import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:firebase_auth/firebase_auth.dart';

/// Wraps Firebase Phone Authentication.
/// Usage:
///   1. Call [sendOtp] → user gets SMS from Firebase.
///   2. Call [verifyOtp] with the OTP user typed → returns Firebase ID token.
///   3. POST that token to your server's `/api/app/verify-firebase-token` endpoint.
class FirebaseOtpService {
  static final FirebaseAuth _auth = FirebaseAuth.instance;

  // Set by [sendOtp], used by [verifyOtp].
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
      case 'operation-not-allowed':
        return 'ERROR: Phone Auth is disabled in Firebase OR Identity Toolkit API is restricted in Google Cloud Console. Please check your API Key settings.';
      case 'app-not-authorized':
        return 'Firebase phone auth is not authorized for this app build.';
      case 'session-expired':
        return 'This OTP session expired. Please resend OTP and try again.';
      case 'invalid-verification-code':
        return 'Incorrect OTP. Please check the code and try again.';
      case 'network-request-failed':
        return 'Network issue while contacting Firebase. Check your connection and try again.';
      default:
        return e.message ?? 'Failed to process OTP. Please try again.';
    }
  }

  static Future<void> resetVerification() async {
    _verificationId = null;
    _resendToken = null;
    try {
      await _auth.signOut();
    } catch (_) {}
  }

  /// Sends OTP to [phoneNumber] (e.g. "+919876543210").
  /// [onCodeSent]   → called with verificationId when SMS is sent.
  /// [onError]      → called with error message on failure.
  /// [onAutoVerify] is intentionally not used to sign in automatically because
  /// that can consume the active verification session before the user enters OTP.
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
      if (!forceResend) {
        _verificationId = null;
      }
      watchdog = Timer(const Duration(seconds: 55), () {
        if (callbackHandled) return;
        onError('OTP request timed out. Please tap Resend OTP to try again.');
        finish();
      });

      await _auth.verifyPhoneNumber(
        phoneNumber: phoneNumber,
        forceResendingToken: forceResend ? _resendToken : null,
        timeout: const Duration(seconds: 60),
        verificationCompleted: (PhoneAuthCredential credential) async {
          // Keep the verification session intact for manual OTP entry.
          // SMS autofill already handles the best UX without consuming the session.
          if (credential.smsCode != null && credential.smsCode!.isNotEmpty) {
            debugPrint('[FIREBASE-OTP] SMS code auto-retrieved; waiting for manual verify flow.');
          }
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
      await completer.future;
    } catch (e) {
      finish();
      onError('Failed to send OTP: ${e.toString()}');
    }
  }

  /// Verifies [smsCode] entered by the user.
  /// Returns a FRESH Firebase ID token on success, or throws [FirebaseAuthException].
  static Future<String> verifyOtp({
    required String smsCode,
    String? verificationId,
  }) async {
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

  /// Sign out from Firebase (call on app logout).
  static Future<void> signOut() async {
    try { await _auth.signOut(); } catch (_) {}
  }
}
