import 'package:flutter/material.dart';
import 'package:google_fonts/google_fonts.dart';

class AppColors {
  // Primary
  static const primary = Color(0xFF2D8CFF);
  static const primaryDark = Color(0xFF1A6FDB);
  static const primaryLight = Color(0xFFE8F2FF);

  // Dark theme
  static const darkBg = Color(0xFF0B0B0B);
  static const darkCard = Color(0xFF1A1A1A);
  static const darkSurface = Color(0xFF242424);
  static const darkBorder = Color(0xFF2A2A2A);

  // Light theme
  static const lightBg = Color(0xFFFFFFFF);
  static const lightCard = Color(0xFFF8FAFC);
  static const lightBorder = Color(0xFFE2E8F0);

  // Text
  static const textWhite = Color(0xFFFFFFFF);
  static const textSub = Color(0xFFA0A0A0);
  static const textMuted = Color(0xFF6B7280);
  static const textDark = Color(0xFF1E293B);

  // Status
  static const green = Color(0xFF10B981);
  static const red = Color(0xFFEF4444);
  static const orange = Color(0xFFF59E0B);
  static const purple = Color(0xFF8B5CF6);
}

class AppText {
  static TextStyle heading(BuildContext context) => GoogleFonts.poppins(
    fontSize: 22, fontWeight: FontWeight.w600,
    color: Theme.of(context).brightness == Brightness.dark ? AppColors.textWhite : AppColors.textDark,
  );

  static TextStyle subheading(BuildContext context) => GoogleFonts.poppins(
    fontSize: 15, fontWeight: FontWeight.w600,
    color: Theme.of(context).brightness == Brightness.dark ? AppColors.textWhite : AppColors.textDark,
  );

  static TextStyle body(BuildContext context) => GoogleFonts.poppins(
    fontSize: 14, fontWeight: FontWeight.w400,
    color: Theme.of(context).brightness == Brightness.dark ? AppColors.textSub : AppColors.textMuted,
  );

  static TextStyle label(BuildContext context) => GoogleFonts.poppins(
    fontSize: 12, fontWeight: FontWeight.w500,
    color: Theme.of(context).brightness == Brightness.dark ? AppColors.textSub : AppColors.textMuted,
  );
}

class AppCard {
  static BoxDecoration dark({double radius = 16}) => BoxDecoration(
    color: AppColors.darkCard,
    borderRadius: BorderRadius.circular(radius),
    border: Border.all(color: AppColors.darkBorder, width: 1),
  );

  static BoxDecoration light({double radius = 16}) => BoxDecoration(
    color: AppColors.lightCard,
    borderRadius: BorderRadius.circular(radius),
    border: Border.all(color: AppColors.lightBorder, width: 1),
  );

  static BoxDecoration gradient({double radius = 16}) => BoxDecoration(
    gradient: const LinearGradient(
      colors: [AppColors.primary, AppColors.primaryDark],
      begin: Alignment.topLeft,
      end: Alignment.bottomRight,
    ),
    borderRadius: BorderRadius.circular(radius),
  );
}
