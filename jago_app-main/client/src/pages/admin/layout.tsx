import { useLocation, Link } from "wouter";
import { useState, useEffect, useRef } from "react";
import { useTheme } from "@/components/theme-provider";
import { Logo } from "@/components/Logo";

function useLiveClock() {
  const [time, setTime] = useState(() => new Date().toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" }));
  useEffect(() => {
    const t = setInterval(() => setTime(new Date().toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" })), 30000);
    return () => clearInterval(t);
  }, []);
  return time;
}

function useAdminBootstrap() {
  const [cssReady, setCssReady] = useState(() => {
    // If Bootstrap is already loaded (e.g. cached from previous nav), skip wait
    return !!document.getElementById("admin-bootstrap-css");
  });

  useEffect(() => {
    const cssFiles = [
      { id: "admin-bootstrap-icons-css", href: "/admin-module/css/bootstrap-icons.min.css" },
      { id: "admin-bootstrap-css", href: "/admin-module/css/bootstrap.min.css" },
      { id: "admin-icon-set-css", href: "/admin-module/plugins/icon-set/style.css" },
    ];
    const added: HTMLLinkElement[] = [];
    let loadedCount = 0;
    const total = cssFiles.filter(({ id }) => !document.getElementById(id)).length;

    if (total === 0) { setCssReady(true); return; }

    cssFiles.forEach(({ id, href }) => {
      let link = document.getElementById(id) as HTMLLinkElement | null;
      if (!link) {
        link = document.createElement("link");
        link.rel = "stylesheet";
        link.href = href;
        link.id = id;
        link.onload = () => {
          loadedCount++;
          if (loadedCount >= total) setCssReady(true);
        };
        link.onerror = () => {
          loadedCount++;
          if (loadedCount >= total) setCssReady(true);
        };
        document.head.appendChild(link);
        added.push(link);
      }
    });

    // Fallback: if CSS takes > 1.5s, show anyway
    const fallback = setTimeout(() => setCssReady(true), 1500);
    return () => {
      clearTimeout(fallback);
      added.forEach(el => el.remove());
      cssFiles.forEach(({ id }) => {
        const el = document.getElementById(id);
        if (el) el.remove();
      });
      setCssReady(false);
    };
  }, []);

  return cssReady;
}

interface NavItem {
  label: string;
  icon: string;
  href: string;
}

interface NavSection {
  category: string;
  items: NavItem[];
  roles?: string[]; // undefined = visible to all
}

// Sections accessible per employee role. Super admin / admin see everything.
// Undefined roles = visible to all authenticated admins.
const ROLE_SECTION_ACCESS: Record<string, string[]> = {
  operations_head: ["Dashboard","Zone Management","Trip Management","Promotion Management","User Management","Parcel Management","B2B / Porter","Vehicle Management","Fare Management","Transactions & Reports","Help & Support","Reviews","Business Management"],
  zone_head: ["Dashboard","Zone Management","Trip Management","User Management","Fare Management","Transactions & Reports","Help & Support","Reviews"],
  zone_manager: ["Dashboard","Zone Management","Trip Management","User Management","Fare Management"],
  driver_onboarding_exec: ["Dashboard","User Management","Vehicle Management"],
  support_agent: ["Dashboard","Trip Management","Help & Support","User Management"],
  marketing_exec: ["Dashboard","Promotion Management","User Management","Reviews"],
};

const navSections: NavSection[] = [
  {
    category: "Dashboard",
    items: [
      { label: "Dashboard", icon: "bi-grid-fill", href: "/admin/dashboard" },
      { label: "System Health", icon: "bi-activity", href: "/admin/system-health" },
      { label: "Alert Engine", icon: "bi-robot", href: "/admin/alert-engine" },
      { label: "Service Management", icon: "bi-toggles", href: "/admin/service-management" },
      { label: "Heat Map", icon: "bi-pin-map", href: "/admin/heat-map" },
      { label: "Fleet View", icon: "bi-map-fill", href: "/admin/fleet-view" },
    ],
  },
  {
    category: "Zone Management",
    items: [
      { label: "Zone Setup", icon: "bi-map", href: "/admin/zones" },
      { label: "Popular Locations", icon: "bi-geo-alt-fill", href: "/admin/popular-locations" },
    ],
  },
  {
    category: "Trip Management",
    items: [
      { label: "All Trips", icon: "bi-car-front-fill", href: "/admin/trips" },
      { label: "Car Sharing", icon: "bi-people-fill", href: "/admin/car-sharing" },
      { label: "Intercity Car Sharing", icon: "bi-car-front-fill", href: "/admin/intercity-carsharing" },
      { label: "Local Pool Rides", icon: "bi-people-fill", href: "/admin/local-pool" },
      { label: "Outstation Pool", icon: "bi-signpost-2-fill", href: "/admin/outstation-pool" },
      { label: "Intercity Routes", icon: "bi-map", href: "/admin/intercity-routes" },
      { label: "Parcel Refund Request", icon: "bi-arrow-return-left", href: "/admin/parcel-refunds" },
      { label: "Safety & Emergency", icon: "bi-shield-exclamation", href: "/admin/safety-alerts" },
    ],
  },
  {
    category: "Promotion Management",
    items: [
      { label: "Banner Setup", icon: "bi-flag-fill", href: "/admin/banners" },
      { label: "Coupon Setup", icon: "bi-ticket-fill", href: "/admin/coupons" },
      { label: "Discount Setup", icon: "bi-percent", href: "/admin/discounts" },
      { label: "Referral Management", icon: "bi-share-fill", href: "/admin/referrals" },
      { label: "Spin Wheel", icon: "bi-trophy-fill", href: "/admin/spin-wheel" },
      { label: "Send Notification", icon: "bi-bell-fill", href: "/admin/notifications" },
    ],
  },
  {
    category: "User Management",
    items: [
      { label: "Driver Verification", icon: "bi-shield-check", href: "/admin/driver-verification" },
      { label: "Driver Level Setup", icon: "bi-bar-chart-fill", href: "/admin/driver-levels" },
      { label: "Driver Setup", icon: "bi-person-badge-fill", href: "/admin/drivers" },
      { label: "Insurance Plans", icon: "bi-shield-fill", href: "/admin/insurance" },
      { label: "Withdraw Requests", icon: "bi-cash-coin", href: "/admin/withdrawals" },
      { label: "Customer Level Setup", icon: "bi-person-fill-add", href: "/admin/customer-levels" },
      { label: "Customer Setup", icon: "bi-people-fill", href: "/admin/customers" },
      { label: "Customer Wallet", icon: "bi-wallet-fill", href: "/admin/customer-wallet" },
      { label: "Wallet Bonus", icon: "bi-wallet2", href: "/admin/wallet-bonus" },
      { label: "Employee Setup", icon: "bi-person-square", href: "/admin/employees" },
      { label: "Subscription Plans", icon: "bi-card-checklist", href: "/admin/subscriptions" },
      { label: "Revenue Model", icon: "bi-diagram-3-fill", href: "/admin/revenue-model" },
    ],
  },
  {
    category: "Parcel Management",
    items: [
      { label: "Parcel Orders", icon: "bi-box-seam-fill", href: "/admin/parcel-orders" },
      { label: "Parcel Attributes", icon: "bi-patch-plus", href: "/admin/parcel-attributes" },
    ],
  },
  {
    category: "B2B / Porter",
    items: [
      { label: "B2B Companies", icon: "bi-building-fill", href: "/admin/b2b-companies" },
    ],
  },
  {
    category: "Vehicle Management",
    items: [
      { label: "Vehicle Attribute Setup", icon: "bi-ev-front-fill", href: "/admin/vehicle-attributes" },
      { label: "Vehicle Categories", icon: "bi-truck-front-fill", href: "/admin/vehicles" },
      { label: "Vehicle Requests", icon: "bi-car-front-fill", href: "/admin/vehicle-requests" },
    ],
  },
  {
    category: "Fare Management",
    items: [
      { label: "Trip Fare Setup", icon: "bi-sign-intersection-y-fill", href: "/admin/fares" },
      { label: "Cancel Reasons", icon: "bi-x-circle-fill", href: "/admin/cancellation-reasons" },
      { label: "Parcel Delivery Fare", icon: "bi-box", href: "/admin/parcel-fares" },
      { label: "Surge Pricing", icon: "bi-graph-up-arrow", href: "/admin/surge-pricing" },
    ],
  },
  {
    category: "Transactions & Reports",
    items: [
      { label: "Transactions", icon: "bi-receipt", href: "/admin/transactions" },
      { label: "Reports", icon: "bi-bar-chart-line-fill", href: "/admin/reports" },
      { label: "Driver Earnings", icon: "bi-cash-coin", href: "/admin/driver-earnings" },
      { label: "Driver Wallet", icon: "bi-wallet2", href: "/admin/driver-wallet" },
    ],
  },
  {
    category: "Help & Support",
    items: [
      { label: "Chatting", icon: "bi-chat-left-dots", href: "/admin/chatting" },
      { label: "Call Logs", icon: "bi-telephone-fill", href: "/admin/call-logs" },
      { label: "Refund Requests", icon: "bi-arrow-counterclockwise", href: "/admin/refund-requests" },
    ],
  },
  {
    category: "Developer",
    items: [
      { label: "API Reference", icon: "bi-code-square", href: "/admin/api-docs" },
      { label: "App UI Design", icon: "bi-phone-fill", href: "/admin/app-design" },
    ],
  },
  {
    category: "Reviews",
    items: [
      { label: "Reviews", icon: "bi-star-fill", href: "/admin/reviews" },
    ],
  },
  {
    category: "Business Management",
    items: [
      { label: "Business Setup", icon: "bi-briefcase-fill", href: "/admin/business-setup" },
      { label: "Pages & Media", icon: "bi-file-earmark-break-fill", href: "/admin/pages-media" },
      { label: "App Languages", icon: "bi-translate", href: "/admin/languages" },
      { label: "Configurations", icon: "bi-gear-wide-connected", href: "/admin/configurations" },
      { label: "System Settings", icon: "bi-sliders2-vertical", href: "/admin/settings" },
    ],
  },
];

export default function AdminLayout({ children }: { children: React.ReactNode }) {
  const cssReady = useAdminBootstrap();
  const [location, setLocation] = useLocation();
  const clock = useLiveClock();
  const { theme, setTheme } = useTheme();
  const isDark = theme === "dark";
  const [navSearch, setNavSearch] = useState("");

  const currentPage = (() => {
    for (const section of navSections) {
      for (const item of section.items) {
        if (location === item.href || location.startsWith(item.href + "/")) {
          return { label: item.label, section: section.category };
        }
      }
    }
    return { label: "Dashboard", section: "Overview" };
  })();

  // Persist sidebar fold state across page refreshes
  const [sidebarFolded, setSidebarFolded] = useState(() => {
    try { return localStorage.getItem("jago-sidebar-folded") === "true"; }
    catch { return false; }
  });
  const [mobileOpen, setMobileOpen] = useState(false);
  const [userMenuOpen, setUserMenuOpen] = useState(false);
  const userMenuRef = useRef<HTMLDivElement>(null);

  const admin = (() => {
    try { return JSON.parse(localStorage.getItem("jago-admin") || "{}"); }
    catch { return {}; }
  })();

  const adminName = admin.name || admin.email || "Admin";
  const adminInitials = adminName.split(" ").map((n: string) => n[0]).join("").substring(0, 2).toUpperCase();
  const adminBg = ["#2F7BFF","#7c3aed","#0891b2","#16a34a"][adminName.charCodeAt(0) % 4];

  useEffect(() => {
    if (!admin?.email && !admin?.name) {
      setLocation("/admin/login");
    }
  }, []);

  // Auth token injection is handled in queryClient.ts at module load time.

  useEffect(() => {
    if (sidebarFolded) {
      document.body.classList.add("aside-folded");
    } else {
      document.body.classList.remove("aside-folded");
    }
    try { localStorage.setItem("jago-sidebar-folded", sidebarFolded ? "true" : "false"); }
    catch (_) {}
  }, [sidebarFolded]);

  useEffect(() => {
    if (mobileOpen) {
      document.body.classList.add("aside-open");
    } else {
      document.body.classList.remove("aside-open");
    }
  }, [mobileOpen]);

  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (userMenuRef.current && !userMenuRef.current.contains(e.target as Node)) {
        setUserMenuOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, []);

  const isActive = (href: string) => location === href || location.startsWith(href + "/");

  // Filter nav sections by role — only superadmin gets full access; undefined/null role is DENIED
  const adminRole = (admin.role || "").toLowerCase().trim();
  const isSuperAdmin = adminRole === "superadmin" || adminRole === "super_admin";
  const isAdmin = isSuperAdmin || adminRole === "admin";
  const allowedSections: Set<string> | null = isAdmin ? null : (ROLE_SECTION_ACCESS[adminRole] ? new Set(ROLE_SECTION_ACCESS[adminRole]) : new Set()); // Empty set = no access
  const baseVisibleNav = allowedSections ? navSections.filter(s => allowedSections.has(s.category)) : navSections;
  const searchNeedle = navSearch.trim().toLowerCase();
  const visibleNav = searchNeedle
    ? baseVisibleNav
        .map((section) => ({
          ...section,
          items: section.items.filter((item) => {
            const hay = `${section.category} ${item.label}`.toLowerCase();
            return hay.includes(searchNeedle);
          }),
        }))
        .filter((section) => section.items.length > 0)
    : baseVisibleNav;

  const handleLogout = async () => {
    try {
      await fetch("/api/admin/logout", {
        method: "POST",
        headers: admin?.token ? { Authorization: `Bearer ${admin.token}` } : undefined,
      });
    } catch (_) {}
    localStorage.removeItem("jago-admin");
    setUserMenuOpen(false);
    window.location.href = "/admin/login";
  };

  // Auto-logout after 20 minutes of inactivity
  useEffect(() => {
    const TIMEOUT_MS = 20 * 60 * 1000; // 20 minutes
    let timer: ReturnType<typeof setTimeout>;

    const reset = () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        localStorage.removeItem("jago-admin");
        window.location.href = "/admin/login?reason=timeout";
      }, TIMEOUT_MS);
    };

    const events = ["mousemove", "mousedown", "keydown", "touchstart", "scroll", "click"];
    events.forEach(e => window.addEventListener(e, reset, { passive: true }));
    reset(); // start timer immediately

    return () => {
      clearTimeout(timer);
      events.forEach(e => window.removeEventListener(e, reset));
    };
  }, []);

  // Wait for Bootstrap CSS before rendering — prevents flash of broken layout on refresh
  if (!cssReady) {
    return (
      <div style={{
        minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center",
        background: "#f8fafc", flexDirection: "column", gap: 12
      }}>
        <Logo variant="blue" size="md" />
        <div style={{ fontSize: 13, color: "#64748b", fontWeight: 500 }}>Loading JAGO Admin…</div>
        <div style={{
          width: 40, height: 3, borderRadius: 2, background: "#e2e8f0", overflow: "hidden"
        }}>
          <div style={{
            width: "60%", height: "100%", background: "#2F7BFF",
            animation: "pulse 1s ease-in-out infinite alternate"
          }} />
        </div>
      </div>
    );
  }

  return (
    <div className="admin-wrapper admin-shell">
      <style>{`
        .admin-shell {
          background:
            radial-gradient(circle at top left, rgba(47,123,255,0.08), transparent 22%),
            radial-gradient(circle at top right, rgba(8,145,178,0.08), transparent 20%),
            linear-gradient(180deg, #f8fbff 0%, #f4f7fb 42%, #eef3f9 100%);
        }
        .admin-shell .aside {
          box-shadow: 12px 0 32px rgba(15, 23, 42, 0.14);
          border-right: 1px solid rgba(255,255,255,0.12);
        }
        .admin-shell .aside-header {
          padding-bottom: 18px;
          border-bottom: 1px solid rgba(255,255,255,0.08);
        }
        .admin-shell .user-profile {
          background: linear-gradient(180deg, rgba(255,255,255,0.16), rgba(255,255,255,0.08));
          border: 1px solid rgba(255,255,255,0.14);
          border-radius: 20px;
          padding: 16px 16px 14px;
          box-shadow: inset 0 1px 0 rgba(255,255,255,0.14);
          margin-bottom: 18px;
        }
        .admin-shell .aside-search .search-form__input_group {
          background: rgba(255,255,255,0.12);
          border: 1px solid rgba(255,255,255,0.14);
          border-radius: 16px;
          overflow: hidden;
          transition: border-color .18s ease, background .18s ease, transform .18s ease;
        }
        .admin-shell .aside-search .search-form__input_group:focus-within {
          background: rgba(255,255,255,0.2);
          border-color: rgba(191,219,254,0.7);
          transform: translateY(-1px);
        }
        .admin-shell .aside-search .search-form__input,
        .admin-shell .aside-search .search-form__input::placeholder,
        .admin-shell .aside-search .search-form__icon {
          color: rgba(255,255,255,0.82);
        }
        .admin-shell .nav-category {
          color: rgba(255,255,255,0.42);
          font-size: 10px;
          font-weight: 700;
          letter-spacing: 1.45px;
          margin: 18px 0 8px;
          text-transform: uppercase;
        }
        .admin-shell .main-nav > li > ul > li > a {
          border-radius: 14px;
          margin: 3px 0;
          transition: transform .16s ease, background .16s ease, box-shadow .16s ease;
        }
        .admin-shell .main-nav > li > ul > li > a:hover {
          transform: translateX(2px);
          background: rgba(255,255,255,0.12);
        }
        .admin-shell .main-nav > li.active > a,
        .admin-shell .main-nav > li.open > a {
          background: linear-gradient(90deg, rgba(255,255,255,0.2), rgba(255,255,255,0.1));
          box-shadow: inset 0 0 0 1px rgba(255,255,255,0.1);
        }
        .admin-shell .header {
          backdrop-filter: blur(16px);
          background: rgba(255,255,255,0.82);
          border-bottom: 1px solid rgba(226,232,240,0.9);
          box-shadow: 0 10px 28px rgba(15, 23, 42, 0.06);
        }
        .admin-shell .header-icon-btn,
        .admin-shell .header-avatar-btn {
          box-shadow: 0 8px 24px rgba(15, 23, 42, 0.08);
        }
        .admin-shell .admin-main-inner {
          padding: 26px 26px 30px;
        }
        .admin-shell .admin-surface {
          background: rgba(255,255,255,0.78);
          border: 1px solid rgba(226,232,240,0.92);
          border-radius: 26px;
          box-shadow: 0 24px 50px rgba(15, 23, 42, 0.08);
          padding: 22px 22px 26px;
        }
        .admin-shell .admin-page-header {
          display: flex;
          align-items: flex-start;
          justify-content: space-between;
          gap: 18px;
          padding-bottom: 18px;
          margin-bottom: 22px;
          border-bottom: 1px solid rgba(226,232,240,0.85);
        }
        .admin-shell .admin-page-title {
          font-size: 1.45rem;
          line-height: 1.15;
          font-weight: 800;
          color: #0f172a;
          margin: 0 0 6px;
          letter-spacing: -0.03em;
        }
        .admin-shell .admin-page-subtitle {
          font-size: 13px;
          color: #64748b;
          margin: 0;
          font-weight: 500;
        }
        .admin-shell .admin-page-chip {
          display: inline-flex;
          align-items: center;
          gap: 8px;
          background: linear-gradient(135deg, rgba(47,123,255,0.1), rgba(59,130,246,0.06));
          color: #1e40af;
          border: 1px solid rgba(147,197,253,0.75);
          border-radius: 999px;
          padding: 10px 14px;
          font-size: 12px;
          font-weight: 700;
          white-space: nowrap;
        }
        .admin-shell .admin-empty-note {
          padding: 14px 14px 2px;
          color: rgba(255,255,255,0.62);
          font-size: 12px;
          font-weight: 500;
        }
        .admin-shell .container-fluid {
          padding-left: 0;
          padding-right: 0;
        }
        .admin-shell .card {
          border: 1px solid rgba(226,232,240,0.92);
          border-radius: 22px;
          box-shadow: 0 16px 38px rgba(15, 23, 42, 0.06);
          overflow: hidden;
          background: linear-gradient(180deg, rgba(255,255,255,0.98), rgba(248,250,252,0.98));
        }
        .admin-shell .card-header {
          background: linear-gradient(180deg, rgba(255,255,255,0.96), rgba(248,250,252,0.96)) !important;
          border-bottom: 1px solid rgba(226,232,240,0.82) !important;
        }
        .admin-shell .card-body {
          padding: 1.15rem 1.25rem;
        }
        .admin-shell .table-responsive {
          border: 1px solid rgba(226,232,240,0.85);
          border-radius: 18px;
          background: rgba(255,255,255,0.86);
          box-shadow: inset 0 1px 0 rgba(255,255,255,0.65);
        }
        .admin-shell .table {
          margin-bottom: 0;
          vertical-align: middle;
        }
        .admin-shell .table > :not(caption) > * > * {
          padding: 14px 16px;
          border-bottom-color: rgba(226,232,240,0.72);
        }
        .admin-shell .table > thead {
          background: linear-gradient(180deg, #f8fbff 0%, #f1f5f9 100%);
        }
        .admin-shell .table > thead th {
          font-size: 11px;
          font-weight: 800;
          color: #64748b;
          text-transform: uppercase;
          letter-spacing: 0.08em;
          border-bottom-color: rgba(226,232,240,0.9);
        }
        .admin-shell .table > tbody tr {
          transition: background-color .18s ease, transform .18s ease;
        }
        .admin-shell .table > tbody tr:hover {
          background: rgba(248,250,252,0.92);
        }
        .admin-shell .form-label,
        .admin-shell .form-label-jago {
          display: inline-flex;
          align-items: center;
          gap: 6px;
          margin-bottom: 8px;
          font-size: 12px;
          font-weight: 700;
          color: #334155;
          letter-spacing: -0.01em;
        }
        .admin-shell .form-control,
        .admin-shell .form-select,
        .admin-shell .admin-form-control,
        .admin-shell textarea.form-control,
        .admin-shell input.admin-form-control,
        .admin-shell textarea.admin-form-control,
        .admin-shell select.admin-form-control {
          min-height: 46px;
          border-radius: 14px !important;
          border: 1px solid rgba(203,213,225,0.92) !important;
          background: rgba(255,255,255,0.96) !important;
          color: #0f172a !important;
          box-shadow: 0 1px 2px rgba(15,23,42,0.02);
          transition: border-color .18s ease, box-shadow .18s ease, background-color .18s ease;
          padding: 11px 14px;
          font-size: 13px;
          font-weight: 500;
        }
        .admin-shell textarea.form-control,
        .admin-shell textarea.admin-form-control {
          min-height: 110px;
          resize: vertical;
        }
        .admin-shell .form-control::placeholder,
        .admin-shell .admin-form-control::placeholder {
          color: #94a3b8;
          font-weight: 500;
        }
        .admin-shell .form-control:focus,
        .admin-shell .form-select:focus,
        .admin-shell .admin-form-control:focus {
          border-color: rgba(96,165,250,0.95) !important;
          box-shadow: 0 0 0 4px rgba(59,130,246,0.12), 0 8px 20px rgba(59,130,246,0.08) !important;
          background: #fff !important;
        }
        .admin-shell .input-group {
          border-radius: 14px;
        }
        .admin-shell .input-group > .form-control,
        .admin-shell .input-group > .form-select,
        .admin-shell .input-group > .admin-form-control {
          position: relative;
          z-index: 1;
        }
        .admin-shell .input-group-text {
          border-radius: 14px !important;
          border: 1px solid rgba(203,213,225,0.92) !important;
          background: linear-gradient(180deg, #f8fafc 0%, #f1f5f9 100%) !important;
          color: #475569 !important;
          font-size: 12px;
          font-weight: 700;
          padding: 0 14px;
        }
        .admin-shell .btn {
          border-radius: 14px;
          font-weight: 700;
          letter-spacing: -0.01em;
          box-shadow: 0 8px 20px rgba(15,23,42,0.04);
          transition: transform .16s ease, box-shadow .16s ease, background-color .16s ease, border-color .16s ease;
        }
        .admin-shell .btn:hover {
          transform: translateY(-1px);
          box-shadow: 0 14px 28px rgba(15,23,42,0.08);
        }
        .admin-shell .btn:active {
          transform: translateY(0);
        }
        .admin-shell .btn-sm {
          border-radius: 12px;
          padding: 8px 13px;
          font-size: 12px;
        }
        .admin-shell .btn-primary {
          background: linear-gradient(135deg, #2f7bff 0%, #1d4ed8 100%);
          border-color: rgba(37,99,235,0.92);
        }
        .admin-shell .btn-primary:hover,
        .admin-shell .btn-primary:focus {
          background: linear-gradient(135deg, #2563eb 0%, #1e40af 100%);
          border-color: rgba(30,64,175,0.95);
        }
        .admin-shell .btn-outline-secondary,
        .admin-shell .btn-light {
          border-color: rgba(203,213,225,0.92);
          background: rgba(255,255,255,0.92);
          color: #334155;
        }
        .admin-shell .btn-outline-secondary:hover,
        .admin-shell .btn-light:hover {
          background: #f8fafc;
          color: #0f172a;
          border-color: rgba(148,163,184,0.72);
        }
        .admin-shell .badge {
          border-radius: 999px;
          padding: 7px 10px;
          font-size: 10.5px;
          font-weight: 800;
          letter-spacing: 0.03em;
        }
        .admin-shell .modal.show {
          background: rgba(15,23,42,0.42);
          backdrop-filter: blur(6px);
        }
        .admin-shell .modal-dialog {
          margin-top: 2.5rem;
          margin-bottom: 2.5rem;
        }
        .admin-shell .modal-content {
          border: 1px solid rgba(226,232,240,0.9);
          border-radius: 24px;
          overflow: hidden;
          background: linear-gradient(180deg, rgba(255,255,255,0.99), rgba(248,250,252,0.98));
          box-shadow: 0 28px 80px rgba(15,23,42,0.18);
        }
        .admin-shell .modal-header,
        .admin-shell .modal-footer {
          border-color: rgba(226,232,240,0.86);
          background: rgba(255,255,255,0.82);
        }
        .admin-shell .modal-header {
          padding: 18px 22px;
        }
        .admin-shell .modal-body {
          padding: 20px 22px 22px;
        }
        .admin-shell .modal-footer {
          padding: 16px 22px 20px;
          gap: 10px;
        }
        .admin-shell .modal-title {
          font-size: 1.15rem;
          font-weight: 800;
          color: #0f172a;
          letter-spacing: -0.02em;
        }
        .admin-shell .dropdown-menu {
          border-radius: 18px;
          border: 1px solid rgba(226,232,240,0.88);
          box-shadow: 0 20px 46px rgba(15,23,42,0.14);
          padding: 10px;
        }
        .admin-shell .dropdown-item {
          border-radius: 12px;
          font-weight: 600;
          color: #334155;
          padding: 10px 12px;
        }
        .admin-shell .dropdown-item:hover {
          background: #f8fafc;
        }
        .admin-shell .dropdown-item-text {
          padding: 10px 12px 8px;
        }
        .admin-shell .pagination,
        .admin-shell .d-flex.gap-2,
        .admin-shell .d-flex.flex-wrap.gap-2 {
          row-gap: 10px !important;
        }
        .admin-shell .nav-pills .nav-link,
        .admin-shell .nav-tabs .nav-link {
          border-radius: 14px;
          font-weight: 700;
        }
        .admin-shell .text-muted {
          color: #64748b !important;
        }
        @media (max-width: 991px) {
          .admin-shell .admin-main-inner {
            padding: 18px 14px 22px;
          }
          .admin-shell .admin-surface {
            border-radius: 20px;
            padding: 18px 16px 20px;
          }
          .admin-shell .admin-page-header {
            flex-direction: column;
            align-items: flex-start;
          }
        }
      `}</style>
      {/* Overlay */}
      <div
        className={`aside-overlay${mobileOpen ? " active" : ""}`}
        onClick={() => setMobileOpen(false)}
        data-testid="aside-overlay"
      />

      {/* Sidebar */}
      <aside className="aside">
        <div className="aside-header">
          <a
            href="/admin/dashboard"
            className="logo"
            onClick={(e) => { e.preventDefault(); setLocation("/admin/dashboard"); }}
            style={{ display: "flex", alignItems: "center", gap: 8, textDecoration: "none" }}
          >
            <Logo variant="white" size="sm" style={{ flexShrink: 0 }} />
            <span style={{ fontSize: "0.5rem", fontWeight: 700, color: "rgba(255,255,255,0.6)", letterSpacing: 2.5, marginTop: 1, alignSelf: "flex-end", paddingBottom: 2 }}>ADMIN PANEL</span>
          </a>
          <button
            className="toggle-menu-button"
            onClick={() => setSidebarFolded(!sidebarFolded)}
            data-testid="btn-sidebar-toggle"
          >
            <i className="bi bi-chevron-left"></i>
          </button>
        </div>

        <div className="aside-body-wrapper">
          <div className="aside-body">
            <div className="user-profile">
              <div className="avatar rounded-circle" style={{ background: adminBg, border: "2px solid rgba(255,255,255,0.3)", fontSize: "0.85rem", fontWeight: 700 }}>
                {adminInitials}
              </div>
              <div className="media-body">
                <div className="card-title fw-semibold" data-testid="sidebar-user-email">
                  {adminName}
                </div>
                <span className="card-text">{admin.role || "superadmin"}</span>
              </div>
            </div>

            <div className="aside-search mb-3">
              <div className="search-form__input_group">
                <span className="search-form__icon">
                  <i className="bi bi-search"></i>
                </span>
                <input
                  type="search"
                  className="theme-input-style search-form__input"
                  placeholder="Search Here"
                  value={navSearch}
                  onChange={(e) => setNavSearch(e.target.value)}
                  data-testid="sidebar-search"
                />
              </div>
            </div>

            <ul className="main-nav nav">
              {visibleNav.map((section) => (
                <li key={section.category} className="nav-section-group" style={{ listStyle: "none", padding: 0, margin: 0 }}>
                  <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
                    <li className="nav-category" title={section.category}>
                      {section.category}
                    </li>
                    {section.items.map((item) => (
                      <li key={item.href} className={isActive(item.href) ? "active open" : ""}>
                        <Link
                          href={item.href}
                          data-testid={`nav-${item.label.toLowerCase().replace(/\s+/g, "-")}`}
                          onClick={() => setMobileOpen(false)}
                        >
                          <i className={`bi ${item.icon}`}></i>
                          <span className="link-title">{item.label}</span>
                        </Link>
                      </li>
                    ))}
                  </ul>
                </li>
              ))}
              {visibleNav.length === 0 && (
                <li className="admin-empty-note">
                  No menu matches for "{navSearch.trim()}"
                </li>
              )}
            </ul>

            {/* Sidebar Logout */}
            <div style={{ padding: "8px 10px", borderTop: "1px solid rgba(255,255,255,0.12)", marginTop: 6 }}>
              <button
                onClick={handleLogout}
                data-testid="btn-logout"
                style={{
                  width: "100%",
                  display: "flex",
                  alignItems: "center",
                  gap: 7,
                  padding: "7px 10px",
                  borderRadius: 7,
                  border: "1px solid rgba(255,255,255,0.18)",
                  background: "rgba(255,255,255,0.1)",
                  color: "#fff",
                  fontWeight: 600,
                  fontSize: 12,
                  cursor: "pointer",
                  transition: "all .15s",
                }}
              >
                <i className="bi bi-box-arrow-right" style={{ fontSize: 13 }}></i>
                <span>Sign Out</span>
              </button>
            </div>
          </div>
        </div>
      </aside>

      {/* Header */}
      <header className="header fixed-top">
        <div className="header-inner" style={{ display: "flex", alignItems: "center", justifyContent: "space-between", width: "100%" }}>
          <div className="header-left-col d-flex align-items-center gap-3">
            <button
              className="aside-toggle-mobile border-0 bg-transparent p-0"
              onClick={() => setMobileOpen(!mobileOpen)}
              data-testid="btn-mobile-sidebar"
            >
              <i className="bi bi-list fs-3" style={{ color: isDark ? "#cbd5e1" : "#64748b" }}></i>
            </button>
            {/* Breadcrumb */}
            <div className="d-none d-md-flex align-items-center gap-2">
              <span style={{ fontSize: 11, color: "#94a3b8", fontWeight: 600, textTransform: "uppercase", letterSpacing: ".6px" }}>
                {currentPage.section}
              </span>
              <i className="bi bi-chevron-right" style={{ fontSize: 10, color: "#cbd5e1" }}></i>
              <span style={{ fontSize: 13, color: isDark ? "#e2e8f0" : "#0f172a", fontWeight: 700 }}>{currentPage.label}</span>
            </div>
          </div>
          <div className="header-right-col" style={{ marginLeft: "auto" }}>
            <div className="header-right">
              <ul className="nav justify-content-end align-items-center header-nav-list gap-2">
                {/* Live clock */}
                <li className="d-none d-lg-block">
                  <div style={{
                    background: "linear-gradient(135deg, #EFF6FF, #DBEAFE)",
                    border: "1px solid #BFDBFE",
                    borderRadius: 10,
                    padding: "5px 12px",
                    fontSize: 12,
                    fontWeight: 700,
                    color: "#1E40AF",
                    display: "flex",
                    alignItems: "center",
                    gap: 6
                  }}>
                    <i className="bi bi-clock" style={{ fontSize: 11 }}></i>
                    {clock}
                  </div>
                </li>
                {/* Theme Toggle */}
                <li>
                  <button
                    className="header-icon-btn"
                    data-testid="btn-theme-toggle"
                    onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
                    title={theme === "dark" ? "Switch to Light Mode" : "Switch to Dark Mode"}
                    style={{ fontSize: "1rem" }}
                  >
                    {theme === "dark" ? (
                      <i className="bi bi-sun-fill" style={{ color: "#fbbf24" }}></i>
                    ) : (
                      <i className="bi bi-moon-fill" style={{ color: "#2F7BFF" }}></i>
                    )}
                  </button>
                </li>
                <li>
                  <div className="position-relative">
                    <button className="header-icon-btn" data-testid="btn-notifications">
                      <i className="bi bi-bell-fill"></i>
                    </button>
                    <span style={{
                      position: "absolute", top: 3, right: 3,
                      width: 7, height: 7, borderRadius: "50%",
                      background: "#ef4444", border: "1.5px solid white"
                    }}></span>
                  </div>
                </li>
                <li>
                  <div className="user" ref={userMenuRef}>
                    <button
                      className="avatar avatar-sm rounded-circle header-avatar-btn"
                      onClick={() => setUserMenuOpen(!userMenuOpen)}
                      data-testid="btn-user-menu"
                      style={{ background: adminBg, fontSize: "0.75rem", fontWeight: 700, color: "#fff", letterSpacing: 0 }}
                    >
                      {adminInitials}
                    </button>
                    {userMenuOpen && (
                      <div className="dropdown-menu dropdown-menu-right show">
                        <div className="dropdown-item-text">
                          <h6 className="mb-0">{admin.name || "Admin"}</h6>
                          <span className="text-muted" style={{ fontSize: "0.8rem" }}>{admin.email}</span>
                        </div>
                        <div className="dropdown-divider"></div>
                        <Link href="/admin/settings" className="dropdown-item" onClick={() => setUserMenuOpen(false)}>
                          <i className="bi bi-gear me-2"></i>Settings
                        </Link>
                        <button className="dropdown-item text-danger" onClick={handleLogout} data-testid="menu-logout">
                          <i className="bi bi-box-arrow-right me-2"></i>Sign Out
                        </button>
                      </div>
                    )}
                  </div>
                </li>
              </ul>
            </div>
          </div>
        </div>
      </header>

      {/* Main Content */}
      <div className="main-area admin-main-area">
        <div className="main-area-inner admin-main-inner">
          <div className="admin-surface">
            <div className="admin-page-header">
              <div>
                <h1 className="admin-page-title">{currentPage.label}</h1>
                <p className="admin-page-subtitle">
                  {currentPage.section} workspace with live controls, aligned metrics, and operational visibility.
                </p>
              </div>
              <div className="admin-page-chip">
                <i className="bi bi-shield-check"></i>
                {admin.role || "superadmin"} · Live Control Mode
              </div>
            </div>
            {children}
          </div>
        </div>
      </div>
    </div>
  );
}
