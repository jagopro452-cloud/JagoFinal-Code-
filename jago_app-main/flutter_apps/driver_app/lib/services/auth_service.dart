import 'dart:async';
import 'dart:convert';
import 'package:flutter/material.dart';
import 'package:http/http.dart' as http;
import 'package:shared_preferences/shared_preferences.dart';
import '../config/api_config.dart';
import '../main.dart' show navigatorKey;
import '../models/user_model.dart';
import '../screens/splash_screen.dart';
import 'device_identity_service.dart';
import 'fcm_service.dart';

class AuthService {
  static const _tokenKey = 'auth_token';
  static const _refreshTokenKey = 'refresh_token';
  static const _userKey = 'user_data';
  static const _userNameKey = 'user_name';
  static const _userPhoneKey = 'user_phone';
  static const _userIdKey = 'user_id';
  static const _activeTripKey = 'active_driver_trip_id';
  static Completer<bool>? _refreshInFlight;
  static Completer<void>? _logoutInFlight;

  static Future<String?> getToken() async {
    final prefs = await SharedPreferences.getInstance();
    final token = prefs.getString(_tokenKey)?.trim();
    if (token == null || token.isEmpty) return null;
    return token;
  }

  static Future<String?> getRefreshToken() async {
    final prefs = await SharedPreferences.getInstance();
    final token = prefs.getString(_refreshTokenKey)?.trim();
    if (token == null || token.isEmpty) return null;
    return token;
  }

  static Future<void> saveToken(String token) async {
    final prefs = await SharedPreferences.getInstance();
    await prefs.setString(_tokenKey, token.trim());
  }

  static Future<void> saveRefreshToken(String? refreshToken) async {
    final prefs = await SharedPreferences.getInstance();
    final value = refreshToken?.trim() ?? '';
    if (value.isEmpty) {
      await prefs.remove(_refreshTokenKey);
      return;
    }
    await prefs.setString(_refreshTokenKey, value);
  }

  static Future<void> saveUser(Map<String, dynamic> userData) async {
    final prefs = await SharedPreferences.getInstance();
    await prefs.setString(_userKey, jsonEncode(userData));
    // Save commonly accessed fields separately for quick reads
    final name = userData['fullName'] ?? userData['full_name'] ?? userData['name'] ?? '';
    final phone = userData['phone'] ?? '';
    // CRITICAL: save user_id — socket_service.dart needs this to connect
    final id = userData['id']?.toString() ?? userData['userId']?.toString() ?? userData['user_id']?.toString() ?? '';
    if (name.toString().isNotEmpty) {
      await prefs.setString(_userNameKey, name.toString());
    } else {
      await prefs.remove(_userNameKey);
    }
    if (phone.toString().isNotEmpty) {
      await prefs.setString(_userPhoneKey, phone.toString());
    } else {
      await prefs.remove(_userPhoneKey);
    }
    if (id.isNotEmpty) {
      await prefs.setString(_userIdKey, id);
    } else {
      await prefs.remove(_userIdKey);
    }
  }

  static Future<Map<String, dynamic>?> getSavedUser() async {
    final prefs = await SharedPreferences.getInstance();
    final str = prefs.getString(_userKey);
    if (str == null || str.isEmpty) return null;
    try {
      final decoded = jsonDecode(str);
      if (decoded is Map) return Map<String, dynamic>.from(decoded);
    } catch (_) {}
    return null;
  }

  static Future<bool> isLoggedIn() async {
    final token = await getToken();
    return token != null && token.isNotEmpty;
  }

  static Future<void> clearLocalSession() async {
    final prefs = await SharedPreferences.getInstance();
    await prefs.remove(_tokenKey);
    await prefs.remove(_refreshTokenKey);
    await prefs.remove(_userKey);
    await prefs.remove(_userNameKey);
    await prefs.remove(_userPhoneKey);
    await prefs.remove(_userIdKey);
  }

  static Future<String?> getActiveTripId() async {
    final prefs = await SharedPreferences.getInstance();
    final tripId = prefs.getString(_activeTripKey)?.trim() ?? '';
    return tripId.isEmpty ? null : tripId;
  }

  static Future<bool> hasActiveTripSession() async {
    return (await getActiveTripId()) != null;
  }

  static Future<bool> rehydrateStoredSession({bool refreshProfile = true}) async {
    final prefs = await SharedPreferences.getInstance();
    final token = prefs.getString(_tokenKey)?.trim() ?? '';
    if (token.isEmpty) return false;

    final savedUser = await getSavedUser();
    if (savedUser != null && savedUser.isNotEmpty) {
      await saveUser(savedUser);
    }

    if (!refreshProfile) return true;

    try {
      final res = await http.get(
        Uri.parse(ApiConfig.driverProfile),
        headers: {
          ..._base,
          'Authorization': 'Bearer $token',
        },
      ).timeout(const Duration(seconds: 8));

      if (res.statusCode == 200) {
        if ((res.headers['content-type'] ?? '').contains('application/json')) {
          final body = jsonDecode(res.body);
          if (body is Map) {
            await saveUser(Map<String, dynamic>.from(body));
          }
        }
        return true;
      }

      if (res.statusCode == 401) {
        await clearLocalSession();
        return false;
      }
    } on TimeoutException {
      return true;
    } catch (_) {
      return true;
    }

    return true;
  }

  static const Map<String, String> _base = {
    'Content-Type': 'application/json',
    'User-Agent': 'JAGOPro-Driver/1.0 (Android)',
    'Accept': 'application/json',
  };

  static Future<Map<String, String>> getHeaders() async {
    final token = await getToken();
    return {..._base, if (token != null) 'Authorization': 'Bearer $token'};
  }

  static Future<Map<String, dynamic>> sendOtp(String phone, [String userType = 'driver', bool forceServerOtp = false]) async {
    return {
      'success': false,
      'code': 'FIREBASE_OTP_REQUIRED',
      'message': 'Server OTP is disabled. Use Firebase Phone OTP in the app.',
    };
  }

  static Future<Map<String, dynamic>> verifyOtp(String phone, String otp, [String userType = 'driver']) async {
    return {
      'success': false,
      'code': 'FIREBASE_OTP_REQUIRED',
      'message': 'Server OTP verification is disabled. Verify with Firebase and then call verifyFirebaseToken.',
    };
  }

  static Future<void> logout() async {
    try {
      final headers = await getHeaders();
      await http.post(Uri.parse(ApiConfig.logout), headers: headers)
          .timeout(const Duration(seconds: 30));
    } catch (_) {}
    await clearLocalSession();
  }

  static Future<bool> tryRefreshSession() async {
    final refreshToken = await getRefreshToken();
    if (refreshToken == null || refreshToken.isEmpty) return false;
    try {
      final res = await http
          .post(
            Uri.parse(ApiConfig.refreshSession),
            headers: {
              ..._base,
              'Authorization': 'Bearer $refreshToken',
            },
            body: jsonEncode({
              'deviceId': await DeviceIdentityService.getDeviceId(),
            }),
          )
          .timeout(const Duration(seconds: 15));
      if (res.statusCode != 200) return false;
      final decoded = jsonDecode(res.body);
      if (decoded is! Map) return false;
      final data = Map<String, dynamic>.from(decoded);
      final newAccessToken = data['accessToken']?.toString().trim() ?? '';
      final newRefreshToken = data['refreshToken']?.toString().trim() ?? '';
      if (newAccessToken.isEmpty || newRefreshToken.isEmpty) return false;
      await saveToken(newAccessToken);
      await saveRefreshToken(newRefreshToken);
      return true;
    } catch (_) {
      return false;
    }
  }

  static Future<bool> refreshOnce() async {
    if (_refreshInFlight != null) {
      return _refreshInFlight!.future;
    }

    final completer = Completer<bool>();
    _refreshInFlight = completer;
    try {
      final refreshed = await tryRefreshSession();
      completer.complete(refreshed);
      return refreshed;
    } catch (_) {
      completer.complete(false);
      return false;
    } finally {
      _refreshInFlight = null;
    }
  }

  static Future<void> safeLogout() async {
    if (_logoutInFlight != null) {
      return _logoutInFlight!.future;
    }

    final completer = Completer<void>();
    _logoutInFlight = completer;
    try {
      await logout();
    } finally {
      completer.complete();
      _logoutInFlight = null;
    }
  }

  /// Call when server returns 401 — clears session and redirects to login.
  static Future<void> handle401({String source = 'unknown', bool allowDuringActiveTrip = true}) async {
    final refreshed = await refreshOnce();
    if (refreshed) return;

    if (allowDuringActiveTrip && await hasActiveTripSession()) {
      debugPrint('[AUTH][DRIVER] Suppressing logout during active trip from $source');
      return;
    }

    await safeLogout();
    navigatorKey.currentState?.pushAndRemoveUntil(
      MaterialPageRoute(builder: (_) => const SplashScreen()),
      (route) => false,
    );
  }

  static Future<UserModel?> getProfile() async {
    try {
      final headers = await getHeaders();
      final res = await http.get(Uri.parse(ApiConfig.driverProfile), headers: headers)
          .timeout(const Duration(seconds: 30));
      if (res.statusCode == 200) {
        return UserModel.fromJson(jsonDecode(res.body));
      }
      if (res.statusCode == 401) {
        await handle401(source: 'driver_profile', allowDuringActiveTrip: true);
      }
    } on TimeoutException {
      return null;
    } catch (_) {}
    return null;
  }

  static Future<Map<String, dynamic>> loginWithPassword(String phone, String password) async {
    return {
      'success': false,
      'code': 'FIREBASE_OTP_REQUIRED',
      'message': 'Password login is disabled. Use Firebase Phone OTP.',
    };
  }

  /// Verify a Firebase Phone Auth ID token with our server.
  static Future<Map<String, dynamic>> verifyFirebaseToken(String idToken, String phone, [String userType = 'driver']) async {
    try {
      final res = await http.post(Uri.parse(ApiConfig.verifyFirebaseToken),
        headers: _base,
        body: jsonEncode({
          'firebaseIdToken': idToken,
          'phone': phone,
          'userType': userType,
          'deviceId': await DeviceIdentityService.getDeviceId(),
        }))
          .timeout(const Duration(seconds: 30));
      if (!(res.headers['content-type'] ?? '').contains('application/json')) {
        return {'success': false, 'message': 'Server error. Please try again.'};
      }
      final data = jsonDecode(res.body) as Map<String, dynamic>;
      if (res.statusCode == 200 && data['token'] != null) {
        await saveToken(data['token']);
        await saveRefreshToken(data['refreshToken']?.toString());
        await saveUser(data['user'] ?? data);
        FcmService().onLoginSuccess().catchError((_) {});
      }
      return data;
    } on TimeoutException {
      return {'success': false, 'message': 'Request timed out. Check your connection.'};
    } catch (e) {
      return {'success': false, 'message': 'Network error. Check your connection.'};
    }
  }

  static Future<Map<String, dynamic>> registerWithPassword(String phone, String password, String fullName, {String? email, String? vehicleNumber, String? vehicleModel, String? vehicleCategoryId}) async {
    return {
      'success': false,
      'code': 'FIREBASE_OTP_REQUIRED',
      'message': 'Password registration is disabled. Use Firebase Phone OTP and continue onboarding after verification.',
    };
  }

  static Future<Map<String, dynamic>> forgotPassword(String phone) async {
    try {
      final res = await http.post(Uri.parse(ApiConfig.forgotPassword),
        headers: _base,
        body: jsonEncode({'phone': phone, 'userType': 'driver'}))
          .timeout(const Duration(seconds: 30));
      if (!(res.headers['content-type'] ?? '').contains('application/json')) {
        return {'success': false, 'message': 'Server error. Please try again.'};
      }
      return jsonDecode(res.body);
    } on TimeoutException {
      return {'success': false, 'message': 'Request timed out. Check your connection.'};
    } catch (e) {
      return {'success': false, 'message': 'Network error. Check your connection.'};
    }
  }

  static Future<Map<String, dynamic>> resetPassword(String phone, String otp, String newPassword) async {
    return {
      'success': false,
      'code': 'FIREBASE_OTP_REQUIRED',
      'message': 'Server OTP password reset is disabled. Use resetPasswordWithFirebase after Firebase verification.',
    };
  }

  static Future<Map<String, dynamic>> resetPasswordWithFirebase(String firebaseIdToken, String phone, String newPassword) async {
    try {
      final res = await http.post(Uri.parse(ApiConfig.resetPasswordFirebase),
        headers: _base,
        body: jsonEncode({'firebaseIdToken': firebaseIdToken, 'phone': phone, 'newPassword': newPassword, 'userType': 'driver'}))
          .timeout(const Duration(seconds: 30));
      if (!(res.headers['content-type'] ?? '').contains('application/json')) {
        return {'success': false, 'message': 'Server error. Please try again.'};
      }
      return jsonDecode(res.body);
    } on TimeoutException {
      return {'success': false, 'message': 'Request timed out. Check your connection.'};
    } catch (e) {
      return {'success': false, 'message': 'Network error. Check your connection.'};
    }
  }
}
