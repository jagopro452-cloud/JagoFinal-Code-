import 'dart:async';
import 'dart:convert';
import 'package:flutter/material.dart';
import 'package:http/http.dart' as http;
import 'package:shared_preferences/shared_preferences.dart';
import '../config/api_config.dart';
import '../main.dart' show navigatorKey;
import '../models/user_model.dart';
import '../screens/splash_screen.dart';
import 'fcm_service.dart';

class AuthService {
  static const _tokenKey = 'auth_token';
  static const _userKey = 'user_data';
  static const _userNameKey = 'user_name';
  static const _userPhoneKey = 'user_phone';
  static const _userIdKey = 'user_id';

  static Future<String?> getToken() async {
    final prefs = await SharedPreferences.getInstance();
    return prefs.getString(_tokenKey);
  }

  static Future<void> saveToken(String token) async {
    final prefs = await SharedPreferences.getInstance();
    await prefs.setString(_tokenKey, token.trim());
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
    if (str == null) return null;
    return jsonDecode(str);
  }

  static Future<bool> isLoggedIn() async {
    final token = await getToken();
    return token != null && token.isNotEmpty;
  }

  static Future<void> clearLocalSession() async {
    final prefs = await SharedPreferences.getInstance();
    await prefs.remove(_tokenKey);
    await prefs.remove(_userKey);
    await prefs.remove(_userNameKey);
    await prefs.remove(_userPhoneKey);
    await prefs.remove(_userIdKey);
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
          if (body is Map<String, dynamic>) {
            await saveUser(body);
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

  static Future<Map<String, dynamic>> sendOtp(String phone, [String userType = 'driver']) async {
    try {
      final res = await http.post(
        Uri.parse(ApiConfig.sendOtp),
        headers: _base,
        body: jsonEncode({'phone': phone, 'userType': userType}),
      ).timeout(const Duration(seconds: 30));
      if (!(res.headers['content-type'] ?? '').contains('application/json')) {
        return {'success': false, 'message': 'Server error. Please try again.'};
      }
      return jsonDecode(res.body) as Map<String, dynamic>;
    } on TimeoutException {
      return {'success': false, 'message': 'Request timed out. Check your connection.'};
    } catch (e) {
      return {'success': false, 'message': 'Network error. Check your connection.'};
    }
  }

  static Future<Map<String, dynamic>> verifyOtp(String phone, String otp, [String userType = 'driver']) async {
    try {
      final res = await http.post(
        Uri.parse(ApiConfig.verifyOtp),
        headers: _base,
        body: jsonEncode({'phone': phone, 'otp': otp, 'userType': userType}),
      ).timeout(const Duration(seconds: 30));
      if (!(res.headers['content-type'] ?? '').contains('application/json')) {
        return {'success': false, 'message': 'Server error. Please try again.'};
      }
      final data = jsonDecode(res.body) as Map<String, dynamic>;
      if (res.statusCode == 200 && data['token'] != null) {
        await saveToken(data['token']);
        await saveUser(data['user'] ?? data);
        // Save FCM token to server after login
        FcmService().onLoginSuccess().catchError((_) {});
      }
      return data;
    } on TimeoutException {
      return {'success': false, 'message': 'Request timed out. Check your connection.'};
    } catch (e) {
      return {'success': false, 'message': 'Network error. Check your connection.'};
    }
  }

  static Future<void> logout() async {
    try {
      final headers = await getHeaders();
      await http.post(Uri.parse(ApiConfig.logout), headers: headers)
          .timeout(const Duration(seconds: 30));
    } catch (_) {}
    await clearLocalSession();
  }

  /// Call when server returns 401 — clears session and redirects to login.
  static Future<void> handle401() async {
    await clearLocalSession();
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
    } on TimeoutException {
      return null;
    } catch (_) {}
    return null;
  }

  static Future<Map<String, dynamic>> loginWithPassword(String phone, String password) async {
    try {
      final res = await http.post(Uri.parse(ApiConfig.loginPassword),
        headers: _base,
        body: jsonEncode({'phone': phone, 'password': password, 'userType': 'driver'}))
          .timeout(const Duration(seconds: 30));
      if (!(res.headers['content-type'] ?? '').contains('application/json')) {
        return {'success': false, 'message': 'Server error. Please try again.'};
      }
      final data = jsonDecode(res.body);
      if (res.statusCode == 200 && data['token'] != null) {
        await saveToken(data['token']);
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

  /// Verify a Firebase Phone Auth ID token with our server.
  static Future<Map<String, dynamic>> verifyFirebaseToken(String idToken, String phone, [String userType = 'driver']) async {
    try {
      final res = await http.post(Uri.parse(ApiConfig.verifyFirebaseToken),
        headers: _base,
        body: jsonEncode({'firebaseIdToken': idToken, 'phone': phone, 'userType': userType}))
          .timeout(const Duration(seconds: 30));
      if (!(res.headers['content-type'] ?? '').contains('application/json')) {
        return {'success': false, 'message': 'Server error. Please try again.'};
      }
      final data = jsonDecode(res.body) as Map<String, dynamic>;
      if (res.statusCode == 200 && data['token'] != null) {
        await saveToken(data['token']);
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

  static Future<Map<String, dynamic>> registerWithPassword(
    String phone,
    String password,
    String fullName, {
    String? email,
    String? vehicleNumber,
    String? vehicleModel,
    String? vehicleCategoryId,
    String? referralCode,
  }) async {
    try {
      final body = <String, dynamic>{'phone': phone, 'password': password, 'fullName': fullName, 'userType': 'driver'};
      if (email != null && email.isNotEmpty) body['email'] = email;
      if (referralCode != null && referralCode.trim().isNotEmpty) {
        body['referralCode'] = referralCode.trim().toUpperCase();
      }
      final res = await http.post(Uri.parse(ApiConfig.registerAccount),
        headers: _base,
        body: jsonEncode(body))
          .timeout(const Duration(seconds: 30));
      if (!(res.headers['content-type'] ?? '').contains('application/json')) {
        return {'success': false, 'message': 'Server error. Please try again.'};
      }
      final data = jsonDecode(res.body);
      if (res.statusCode == 200 && data['token'] != null) {
        await saveToken(data['token']);
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
    try {
      final res = await http.post(Uri.parse(ApiConfig.resetPassword),
        headers: _base,
        body: jsonEncode({'phone': phone, 'otp': otp, 'newPassword': newPassword, 'userType': 'driver'}))
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
