import 'package:flutter/material.dart';
import 'theme.dart';
import 'driver_home_screen.dart';

class JagoProDriverApp extends StatelessWidget {
  const JagoProDriverApp({super.key});

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'Jago Pro Driver',
      theme: JagoTheme.themeData,
      debugShowCheckedModeBanner: false,
      initialRoute: '/',
      routes: {
        '/': (_) => const DriverHomeScreen(),
        // Add more routes as needed
      },
    );
  }
}
