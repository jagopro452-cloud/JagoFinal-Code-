import 'dart:math';
import 'package:shared_preferences/shared_preferences.dart';

class DeviceIdentityService {
  static const _deviceIdKey = 'device_id';

  static Future<String> getDeviceId() async {
    final prefs = await SharedPreferences.getInstance();
    final existing = prefs.getString(_deviceIdKey)?.trim() ?? '';
    if (existing.isNotEmpty) return existing;

    final random = Random.secure();
    final bytes = List<int>.generate(16, (_) => random.nextInt(256));
    final hex = bytes.map((b) => b.toRadixString(16).padLeft(2, '0')).join();
    final deviceId = 'cust-$hex';
    await prefs.setString(_deviceIdKey, deviceId);
    return deviceId;
  }
}
