import 'package:flutter/material.dart';

class JagoTheme {
  static const Color primaryBlue = Color(0xFF1A73E8);
  static const Color darkBlue = Color(0xFF0A1F44);
  static const Color background = Colors.white;
  static const Color textDark = Color(0xFF111111);
  static const Color success = Color(0xFF10B981);
  static const Color error = Color(0xFFEF4444);

  static LinearGradient get primaryGradient => const LinearGradient(
    colors: [primaryBlue, darkBlue],
    begin: Alignment.topLeft,
    end: Alignment.bottomRight,
  );

  static ThemeData get themeData => ThemeData(
    fontFamily: 'Poppins',
    primaryColor: primaryBlue,
    scaffoldBackgroundColor: background,
    colorScheme: ColorScheme.light(
      primary: primaryBlue,
      secondary: darkBlue,
      surface: background,
      error: error,
      onPrimary: Colors.white,
      onSurface: textDark,
      onError: Colors.white,
    ),
    textTheme: const TextTheme(
      bodyLarge: TextStyle(color: textDark, fontWeight: FontWeight.w500),
      bodyMedium: TextStyle(color: textDark),
      titleLarge: TextStyle(color: textDark, fontWeight: FontWeight.bold),
    ),
    useMaterial3: true,
  );
}
