import 'package:flutter/material.dart';
import 'package:google_fonts/google_fonts.dart';
import '../../config/jago_theme.dart';

class RatingsScreen extends StatelessWidget {
  final double currentRating;

  const RatingsScreen({Key? key, required this.currentRating}) : super(key: key);

  @override
  Widget build(BuildContext context) {
    // Generate dummy historical ratings based on current rating.
    final List<Map<String, dynamic>> ratingsLog = [
      {'date': 'Today, 2:30 PM', 'rating': 5, 'comment': 'Excellent driving & polite behavior.', 'user': 'Priya S.'},
      {'date': 'Yesterday, 10:15 AM', 'rating': 5, 'comment': 'Clean car, reached on time.', 'user': 'Rahul V.'},
      {'date': '15 Dec, 8:40 PM', 'rating': 4, 'comment': 'Good ride.', 'user': 'Anonymous'},
      {'date': '14 Dec, 1:20 PM', 'rating': 5, 'comment': 'Very professional.', 'user': 'Sneha K.'},
      {'date': '12 Dec, 9:00 AM', 'rating': 4, 'comment': '', 'user': 'Mohit J.'},
      {'date': '10 Dec, 6:15 PM', 'rating': 5, 'comment': 'Great experience.', 'user': 'Anita R.'},
    ];

    return Scaffold(
      backgroundColor: JT.bgSoft,
      appBar: AppBar(
        backgroundColor: Colors.transparent,
        elevation: 0,
        centerTitle: true,
        iconTheme: IconThemeData(color: JT.textPrimary),
        title: Text('My Ratings', style: GoogleFonts.poppins(color: JT.textPrimary, fontWeight: FontWeight.w600)),
      ),
      body: CustomScrollView(
        physics: const BouncingScrollPhysics(),
        slivers: [
          SliverToBoxAdapter(
            child: Padding(
              padding: const EdgeInsets.symmetric(horizontal: 20, vertical: 10),
              child: Column(
                children: [
                  _buildOverallRatingCard(currentRating),
                  const SizedBox(height: 24),
                  Row(
                    children: [
                      Text(
                        'Recent Feedback',
                        style: GoogleFonts.poppins(fontSize: 18, fontWeight: FontWeight.w600, color: JT.textPrimary),
                      ),
                    ],
                  ),
                  const SizedBox(height: 16),
                ],
              ),
            ),
          ),
          SliverPadding(
            padding: const EdgeInsets.symmetric(horizontal: 20),
            sliver: SliverList(
              delegate: SliverChildBuilderDelegate(
                (context, index) {
                  final log = ratingsLog[index];
                  return _buildRatingItem(log);
                },
                childCount: ratingsLog.length,
              ),
            ),
          ),
          const SliverPadding(padding: EdgeInsets.only(bottom: 40)),
        ],
      ),
    );
  }

  Widget _buildOverallRatingCard(double rating) {
    return Container(
      padding: const EdgeInsets.all(24),
      decoration: BoxDecoration(
        gradient: LinearGradient(
          colors: [JT.primary, const Color(0xFF1A50D0)],
          begin: Alignment.topLeft,
          end: Alignment.bottomRight,
        ),
        borderRadius: BorderRadius.circular(24),
        boxShadow: JT.btnShadow,
      ),
      child: Column(
        children: [
          Text(
            'Overall Rating',
            style: GoogleFonts.poppins(color: Colors.white.withValues(alpha: 0.9), fontSize: 16, fontWeight: FontWeight.w500),
          ),
          const SizedBox(height: 8),
          Row(
            mainAxisAlignment: MainAxisAlignment.center,
            crossAxisAlignment: CrossAxisAlignment.end,
            children: [
              Text(
                rating.toStringAsFixed(1),
                style: GoogleFonts.poppins(color: Colors.white, fontSize: 48, fontWeight: FontWeight.w700, height: 1),
              ),
              Padding(
                padding: const EdgeInsets.only(bottom: 8.0, left: 4),
                child: Text(
                  '/ 5.0',
                  style: GoogleFonts.poppins(color: Colors.white.withValues(alpha: 0.8), fontSize: 20, fontWeight: FontWeight.w600),
                ),
              ),
            ],
          ),
          const SizedBox(height: 12),
          Row(
            mainAxisAlignment: MainAxisAlignment.center,
            children: List.generate(5, (index) {
              return Padding(
                padding: const EdgeInsets.symmetric(horizontal: 4),
                child: Icon(
                  index < rating.floor() ? Icons.star_rounded : (index < rating ? Icons.star_half_rounded : Icons.star_outline_rounded),
                  color: Colors.amber,
                  size: 28,
                ),
              );
            }),
          ),
          const SizedBox(height: 16),
          Container(
            padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 8),
            decoration: BoxDecoration(
              color: Colors.white.withValues(alpha: 0.2),
              borderRadius: BorderRadius.circular(20),
            ),
            child: Text(
              'Top 5% of Pilots in your tier',
              style: GoogleFonts.poppins(color: Colors.white, fontSize: 13, fontWeight: FontWeight.w500),
            ),
          )
        ],
      ),
    );
  }

  Widget _buildRatingItem(Map<String, dynamic> log) {
    int stars = log['rating'] as int;
    return Container(
      margin: const EdgeInsets.only(bottom: 12),
      padding: const EdgeInsets.all(16),
      decoration: BoxDecoration(
        color: JT.bg,
        borderRadius: BorderRadius.circular(16),
        boxShadow: JT.cardShadow,
        border: Border.all(color: JT.border.withValues(alpha: 0.5)),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            mainAxisAlignment: MainAxisAlignment.spaceBetween,
            children: [
              Text(
                log['user'],
                style: GoogleFonts.poppins(fontSize: 15, fontWeight: FontWeight.w600, color: JT.textPrimary),
              ),
              Row(
                children: List.generate(5, (index) {
                  return Icon(
                    index < stars ? Icons.star_rounded : Icons.star_outline_rounded,
                    color: index < stars ? Colors.amber : Colors.grey.shade300,
                    size: 16,
                  );
                }),
              )
            ],
          ),
          const SizedBox(height: 6),
          if ((log['comment'] as String).isNotEmpty) ...[
            Text(
              '"${log['comment']}"',
              style: GoogleFonts.poppins(fontSize: 14, fontStyle: FontStyle.italic, color: JT.textSecondary),
            ),
            const SizedBox(height: 8),
          ],
          Text(
            log['date'],
            style: GoogleFonts.poppins(fontSize: 12, color: JT.iconInactive),
          ),
        ],
      ),
    );
  }
}
