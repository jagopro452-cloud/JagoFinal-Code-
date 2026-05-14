import 'package:flutter/material.dart';

// -----------------------------------------------------------------------------
// STATE ENUMS
// -----------------------------------------------------------------------------
enum ServiceCategory { ride, parcel }

class VehicleOption {
  final String id;
  final String title;
  final IconData icon;

  VehicleOption({required this.id, required this.title, required this.icon});
}

// -----------------------------------------------------------------------------
// MAIN HOME SCREEN (STATEFUL)
// -----------------------------------------------------------------------------
class ModernHomeScreen extends StatefulWidget {
  const ModernHomeScreen({super.key});

  @override
  State<ModernHomeScreen> createState() => _ModernHomeScreenState();
}

class _ModernHomeScreenState extends State<ModernHomeScreen> {
  ServiceCategory _selectedCategory = ServiceCategory.ride;
  String _selectedVehicleId = 'bike'; // default selected

  // Dummy Data for Services
  final List<VehicleOption> _rideOptions = [
    VehicleOption(id: 'bike', title: 'Bike', icon: Icons.two_wheeler),
    VehicleOption(id: 'auto', title: 'Auto', icon: Icons.electric_rickshaw),
    VehicleOption(id: 'car', title: 'Car', icon: Icons.directions_car),
  ];

  final List<VehicleOption> _parcelOptions = [
    VehicleOption(id: 'parcel_bike', title: '2-Wheeler', icon: Icons.local_mall),
    VehicleOption(id: 'mini_truck', title: 'Mini Truck', icon: Icons.local_shipping),
    VehicleOption(id: 'van', title: 'Van', icon: Icons.airport_shuttle),
  ];

  @override
  Widget build(BuildContext context) {
    final currentOptions = _selectedCategory == ServiceCategory.ride
        ? _rideOptions
        : _parcelOptions;

    return Scaffold(
      backgroundColor: const Color(0xFFF4F6F8),
      body: Stack(
        children: [
          // 1. TOP MAP HEADER
          const TopMapHeader(),

          // MAIN SCROLLABLE BODY
          SafeArea(
            bottom: false, // Let BottomNav handle bottom safe area
            child: SingleChildScrollView(
              physics: const BouncingScrollPhysics(),
              child: Padding(
                padding: const EdgeInsets.symmetric(horizontal: 20.0),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    const SizedBox(height: 50), // Space for header notification
                    
                    // 2. GREETING & BOOKING CARD
                    GreetingAndBookingCard(
                      selectedCategory: _selectedCategory,
                      onCategoryChanged: (category) {
                        setState(() {
                          _selectedCategory = category;
                          // Reset vehicle selection when category changes
                          _selectedVehicleId = category == ServiceCategory.ride
                              ? 'bike'
                              : 'parcel_bike';
                        });
                      },
                    ),
                    const SizedBox(height: 24),

                    // 4. SERVICES SECTION
                    const SectionHeader(title: "Our Services"),
                    const SizedBox(height: 12),
                    ServicesList(
                      options: currentOptions,
                      selectedId: _selectedVehicleId,
                      onVehicleSelected: (id) {
                        setState(() {
                          _selectedVehicleId = id;
                        });
                      },
                    ),
                    const SizedBox(height: 28),

                    // 5. QUICK PICKS SECTION
                    const SectionHeader(title: "Quick Picks"),
                    const SizedBox(height: 12),
                    const QuickPicksRow(),
                    
                    const SizedBox(height: 100), // Padding for bottom nav
                  ],
                ),
              ),
            ),
          ),

          // 6. BOTTOM NAVIGATION BAR
          const Align(
            alignment: Alignment.bottomCenter,
            child: CustomBottomNavBar(),
          ),
        ],
      ),
    );
  }
}

// -----------------------------------------------------------------------------
// WIDGET COMPONENTS
// -----------------------------------------------------------------------------

/// 1) Top Map Header (Visual background)
class TopMapHeader extends StatelessWidget {
  const TopMapHeader({super.key});

  @override
  Widget build(BuildContext context) {
    return Container(
      height: 300,
      width: double.infinity,
      decoration: BoxDecoration(
        color: Colors.blue.shade50,
        gradient: LinearGradient(
          begin: Alignment.topCenter,
          end: Alignment.bottomCenter,
          colors: [
            Colors.blue.shade100.withValues(alpha: 0.6),
            const Color(0xFFF4F6F8), // Fades into scaffold background
          ],
        ),
      ),
      child: SafeArea(
        child: Align(
          alignment: Alignment.topRight,
          child: Padding(
            padding: const EdgeInsets.all(20.0),
            child: Container(
              decoration: BoxDecoration(
                color: Colors.white,
                shape: BoxShape.circle,
                boxShadow: [
                  BoxShadow(
                    color: Colors.black.withValues(alpha: 0.05),
                    blurRadius: 10,
                    spreadRadius: 1,
                  ),
                ],
              ),
              child: IconButton(
                icon: const Icon(Icons.notifications_outlined, color: Color(0xFF111827)),
                onPressed: () {},
              ),
            ),
          ),
        ),
      ),
    );
  }
}

/// 2) Greeting + Search Card (includes 3) Ride/Parcel toggle)
class GreetingAndBookingCard extends StatelessWidget {
  final ServiceCategory selectedCategory;
  final ValueChanged<ServiceCategory> onCategoryChanged;

  const GreetingAndBookingCard({
    super.key,
    required this.selectedCategory,
    required this.onCategoryChanged,
  });

  @override
  Widget build(BuildContext context) {
    return Container(
      decoration: BoxDecoration(
        color: Colors.white,
        borderRadius: BorderRadius.circular(24),
        boxShadow: [
          BoxShadow(
            color: Colors.black.withValues(alpha: 0.04),
            blurRadius: 20,
            offset: const Offset(0, 10),
            spreadRadius: 2,
          ),
        ],
      ),
      padding: const EdgeInsets.all(24),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          // Greeting text
          const Text(
            "Hello, Vamsi 👋",
            style: TextStyle(
              fontSize: 22,
              fontWeight: FontWeight.w700,
              color: Color(0xFF111827),
            ),
          ),
          const SizedBox(height: 6),
          Text(
            selectedCategory == ServiceCategory.ride 
                ? "Where are you going today?"
                : "What do you need to deliver?",
            style: const TextStyle(
              fontSize: 15,
              fontWeight: FontWeight.w500,
              color: Color(0xFF6B7280),
            ),
          ),
          const SizedBox(height: 24),

          // Location Fields
          const LocationInputField(
            icon: Icons.my_location,
            iconColor: Color(0xFF2563EB),
            title: "Pickup location",
            subtitle: "Current Location",
          ),
          
          // Divider Line
          Padding(
            padding: const EdgeInsets.only(left: 17.0, top: 4, bottom: 4),
            child: Container(
              height: 20,
              width: 2,
              color: Colors.grey.shade200,
            ),
          ),

          const LocationInputField(
            icon: Icons.location_on,
            iconColor: Color(0xFF0D9488),
            title: "Where to?",
            subtitle: "Enter destination",
          ),
          
          const SizedBox(height: 28),

          // Primary CTA Button
          PrimaryGradientButton(
            text: selectedCategory == ServiceCategory.ride ? "Book Ride 🚀" : "Book Delivery 📦",
            onPressed: () {
              Navigator.pushNamed(context, '/booking');
            },
          ),

          const SizedBox(height: 24),

          // 3. RIDE / PARCEL TOGGLE
          SegmentedToggle(
            selectedCategory: selectedCategory,
            onChanged: onCategoryChanged,
          ),
        ],
      ),
    );
  }
}

/// Location Input Field Mockup
class LocationInputField extends StatelessWidget {
  final IconData icon;
  final Color iconColor;
  final String title;
  final String subtitle;

  const LocationInputField({
    super.key,
    required this.icon,
    required this.iconColor,
    required this.title,
    required this.subtitle,
  });

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 12),
      decoration: BoxDecoration(
        color: const Color(0xFFF9FAFB),
        borderRadius: BorderRadius.circular(16),
        border: Border.all(color: Colors.grey.shade100),
      ),
      child: Row(
        children: [
          Container(
            padding: const EdgeInsets.all(8),
            decoration: BoxDecoration(
              color: iconColor.withValues(alpha: 0.1),
              shape: BoxShape.circle,
            ),
            child: Icon(icon, size: 20, color: iconColor),
          ),
          const SizedBox(width: 16),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  title,
                  style: const TextStyle(
                    fontSize: 15,
                    fontWeight: FontWeight.w600,
                    color: Color(0xFF111827),
                  ),
                ),
                Text(
                  subtitle,
                  style: const TextStyle(
                    fontSize: 13,
                    color: Color(0xFF6B7280),
                  ),
                ),
              ],
            ),
          ),
          Icon(Icons.chevron_right, color: Colors.grey.shade400),
        ],
      ),
    );
  }
}

/// Gradient Primary Button
class PrimaryGradientButton extends StatelessWidget {
  final String text;
  final VoidCallback onPressed;

  const PrimaryGradientButton({
    super.key,
    required this.text,
    required this.onPressed,
  });

  @override
  Widget build(BuildContext context) {
    return Container(
      width: double.infinity,
      height: 56,
      decoration: BoxDecoration(
        borderRadius: BorderRadius.circular(18),
        gradient: const LinearGradient(
          colors: [Color(0xFF2563EB), Color(0xFF0D9488)],
          begin: Alignment.centerLeft,
          end: Alignment.centerRight,
        ),
        boxShadow: [
          BoxShadow(
            color: const Color(0xFF2563EB).withValues(alpha: 0.3),
            blurRadius: 15,
            offset: const Offset(0, 8),
          ),
        ],
      ),
      child: Material(
        color: Colors.transparent,
        child: InkWell(
          borderRadius: BorderRadius.circular(18),
          onTap: onPressed,
          child: Center(
            child: Text(
              text,
              style: const TextStyle(
                color: Colors.white,
                fontSize: 18,
                fontWeight: FontWeight.bold,
                letterSpacing: 0.5,
              ),
            ),
          ),
        ),
      ),
    );
  }
}

/// Segmented Toggle for Ride/Parcel
class SegmentedToggle extends StatelessWidget {
  final ServiceCategory selectedCategory;
  final ValueChanged<ServiceCategory> onChanged;

  const SegmentedToggle({
    super.key,
    required this.selectedCategory,
    required this.onChanged,
  });

  @override
  Widget build(BuildContext context) {
    return Container(
      height: 48,
      decoration: BoxDecoration(
        color: const Color(0xFFF3F4F6),
        borderRadius: BorderRadius.circular(24),
      ),
      child: Stack(
        children: [
          // Animated Background Pill
          AnimatedAlign(
            duration: const Duration(milliseconds: 250),
            curve: Curves.easeInOut,
            alignment: selectedCategory == ServiceCategory.ride
                ? Alignment.centerLeft
                : Alignment.centerRight,
            child: FractionallySizedBox(
              widthFactor: 0.5,
              child: Container(
                margin: const EdgeInsets.all(4),
                decoration: BoxDecoration(
                  borderRadius: BorderRadius.circular(20),
                  color: Colors.white,
                  boxShadow: [
                    BoxShadow(
                      color: Colors.black.withValues(alpha: 0.05),
                      blurRadius: 5,
                      offset: const Offset(0, 2),
                    ),
                  ],
                ),
              ),
            ),
          ),
          // Buttons
          Row(
            children: [
              Expanded(
                child: GestureDetector(
                  behavior: HitTestBehavior.opaque,
                  onTap: () => onChanged(ServiceCategory.ride),
                  child: Center(
                    child: AnimatedDefaultTextStyle(
                      duration: const Duration(milliseconds: 200),
                      style: TextStyle(
                        fontFamily: 'Inter', // Fallback, uses default if missing
                        fontWeight: selectedCategory == ServiceCategory.ride
                            ? FontWeight.w700
                            : FontWeight.w500,
                        color: selectedCategory == ServiceCategory.ride
                            ? const Color(0xFF2563EB)
                            : const Color(0xFF6B7280),
                        fontSize: 15,
                      ),
                      child: const Text("Ride"),
                    ),
                  ),
                ),
              ),
              Expanded(
                child: GestureDetector(
                  behavior: HitTestBehavior.opaque,
                  onTap: () => onChanged(ServiceCategory.parcel),
                  child: Center(
                    child: AnimatedDefaultTextStyle(
                      duration: const Duration(milliseconds: 200),
                      style: TextStyle(
                        fontWeight: selectedCategory == ServiceCategory.parcel
                            ? FontWeight.w700
                            : FontWeight.w500,
                        color: selectedCategory == ServiceCategory.parcel
                            ? const Color(0xFF2563EB)
                            : const Color(0xFF6B7280),
                        fontSize: 15,
                      ),
                      child: const Text("Parcel"),
                    ),
                  ),
                ),
              ),
            ],
          ),
        ],
      ),
    );
  }
}

/// Generic Section Header
class SectionHeader extends StatelessWidget {
  final String title;

  const SectionHeader({super.key, required this.title});

  @override
  Widget build(BuildContext context) {
    return Text(
      title,
      style: const TextStyle(
        fontSize: 18,
        fontWeight: FontWeight.w700,
        color: Color(0xFF111827),
      ),
    );
  }
}

/// 4) Services List (Horizontally scrollable)
class ServicesList extends StatelessWidget {
  final List<VehicleOption> options;
  final String selectedId;
  final ValueChanged<String> onVehicleSelected;

  const ServicesList({
    super.key,
    required this.options,
    required this.selectedId,
    required this.onVehicleSelected,
  });

  @override
  Widget build(BuildContext context) {
    return SizedBox(
      height: 120, // Fixed height for cards
      child: ListView.builder(
        scrollDirection: Axis.horizontal,
        physics: const BouncingScrollPhysics(),
        itemCount: options.length,
        itemBuilder: (context, index) {
          final option = options[index];
          final isSelected = option.id == selectedId;
          
          return Padding(
            padding: const EdgeInsets.only(right: 16.0),
            child: GestureDetector(
              onTap: () => onVehicleSelected(option.id),
              child: AnimatedContainer(
                duration: const Duration(milliseconds: 200),
                width: 105,
                decoration: BoxDecoration(
                  color: isSelected ? const Color(0xFFEFF6FF) : Colors.white,
                  borderRadius: BorderRadius.circular(20),
                  border: Border.all(
                    color: isSelected ? const Color(0xFF2563EB) : Colors.transparent,
                    width: 2,
                  ),
                  boxShadow: [
                    if (!isSelected)
                      BoxShadow(
                        color: Colors.black.withValues(alpha: 0.03),
                        blurRadius: 10,
                        offset: const Offset(0, 4),
                      ),
                  ],
                ),
                child: Column(
                  mainAxisAlignment: MainAxisAlignment.center,
                  children: [
                    Stack(
                      alignment: Alignment.center,
                      children: [
                        // Soft background circle for icon
                        Container(
                          width: 50,
                          height: 50,
                          decoration: BoxDecoration(
                            color: isSelected 
                                ? const Color(0xFFDBEAFE) 
                                : const Color(0xFFF3F4F6),
                            shape: BoxShape.circle,
                          ),
                        ),
                        // The Icon (Replace with image asset if desired)
                        Icon(
                          option.icon,
                          size: 32,
                          color: isSelected 
                              ? const Color(0xFF2563EB) 
                              : const Color(0xFF4B5563),
                        ),
                      ],
                    ),
                    const SizedBox(height: 12),
                    Text(
                      option.title,
                      style: TextStyle(
                        fontSize: 14,
                        fontWeight: isSelected ? FontWeight.bold : FontWeight.w600,
                        color: isSelected 
                            ? const Color(0xFF2563EB) 
                            : const Color(0xFF4B5563),
                      ),
                    ),
                  ],
                ),
              ),
            ),
          );
        },
      ),
    );
  }
}

/// 5) Quick Picks Row
class QuickPicksRow extends StatelessWidget {
  const QuickPicksRow({super.key});

  @override
  Widget build(BuildContext context) {
    return Row(
      mainAxisAlignment: MainAxisAlignment.spaceBetween,
      children: [
        _QuickPickItem(icon: Icons.home_rounded, label: "Home"),
        _QuickPickItem(icon: Icons.work_rounded, label: "Work"),
        _QuickPickItem(icon: Icons.history_rounded, label: "Recent"),
      ],
    );
  }
}

class _QuickPickItem extends StatelessWidget {
  final IconData icon;
  final String label;

  const _QuickPickItem({required this.icon, required this.label});

  @override
  Widget build(BuildContext context) {
    // Calculates a width to fit 3 items beautifully with spacing
    return Expanded(
      child: Container(
        margin: const EdgeInsets.symmetric(horizontal: 4),
        padding: const EdgeInsets.symmetric(vertical: 16),
        decoration: BoxDecoration(
          color: Colors.white,
          borderRadius: BorderRadius.circular(16),
          boxShadow: [
            BoxShadow(
              color: Colors.black.withValues(alpha: 0.02),
              blurRadius: 8,
              offset: const Offset(0, 4),
            ),
          ],
        ),
        child: Column(
          children: [
            Icon(icon, color: const Color(0xFF4B5563), size: 28),
            const SizedBox(height: 8),
            Text(
              label,
              style: const TextStyle(
                fontSize: 13,
                fontWeight: FontWeight.w600,
                color: Color(0xFF4B5563),
              ),
            ),
          ],
        ),
      ),
    );
  }
}

/// 6) Premium Floating Bottom Navigation Bar
class CustomBottomNavBar extends StatefulWidget {
  const CustomBottomNavBar({super.key});

  @override
  State<CustomBottomNavBar> createState() => _CustomBottomNavBarState();
}

class _CustomBottomNavBarState extends State<CustomBottomNavBar> {
  int _currentIndex = 0;

  @override
  Widget build(BuildContext context) {
    return Container(
      margin: const EdgeInsets.only(left: 20, right: 20, bottom: 20),
      padding: const EdgeInsets.symmetric(horizontal: 20, vertical: 12),
      decoration: BoxDecoration(
        color: Colors.white,
        borderRadius: BorderRadius.circular(30),
        boxShadow: [
          BoxShadow(
            color: Colors.black.withValues(alpha: 0.1),
            blurRadius: 20,
            offset: const Offset(0, 10),
          ),
        ],
      ),
      child: SafeArea(
        top: false,
        child: Row(
          mainAxisAlignment: MainAxisAlignment.spaceBetween,
          children: [
            _buildNavItem(0, Icons.explore_rounded, "Home"),
            _buildNavItem(1, Icons.receipt_long_rounded, "Trips"),
            _buildNavItem(2, Icons.account_balance_wallet_rounded, "Wallet"),
            _buildNavItem(3, Icons.person_rounded, "Profile"),
          ],
        ),
      ),
    );
  }

  Widget _buildNavItem(int index, IconData icon, String label) {
    final isSelected = _currentIndex == index;
    final color = isSelected ? const Color(0xFF2563EB) : const Color(0xFF9CA3AF);

    return GestureDetector(
      onTap: () {
        setState(() {
          _currentIndex = index;
        });
      },
      behavior: HitTestBehavior.opaque,
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          AnimatedContainer(
            duration: const Duration(milliseconds: 200),
            padding: const EdgeInsets.all(8),
            decoration: BoxDecoration(
              color: isSelected ? const Color(0xFFEFF6FF) : Colors.transparent,
              borderRadius: BorderRadius.circular(16),
            ),
            child: Icon(icon, color: color, size: 26),
          ),
          const SizedBox(height: 4),
          Text(
            label,
            style: TextStyle(
              fontSize: 11,
              fontWeight: isSelected ? FontWeight.bold : FontWeight.w600,
              color: color,
            ),
          ),
        ],
      ),
    );
  }
}
