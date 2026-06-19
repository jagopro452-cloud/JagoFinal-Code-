import { useLocation, Link } from "wouter";
import { useMemo, useState, useEffect, useLayoutEffect, useRef } from "react";
import { useQuery } from "@tanstack/react-query";
import { useTheme } from "@/components/theme-provider";
import { Logo } from "@/components/Logo";
import {
  AdminSession,
  getSavedAdminSession,
  logoutAdminSession,
  queryClient,
  verifyAdminSession,
} from "@/lib/queryClient";
import { AdminConfirmHost } from "./components/AdminPrimitives";

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
      added.forEach((el) => {
        el.onload = null;
        el.onerror = null;
      });
    };
  }, []);

  return cssReady;
}

export interface NavItem {
  label: string;
  icon: string;
  href: string;
}

export interface NavSection {
  category: string;
  items: NavItem[];
  roles?: string[]; // undefined = visible to all
}

// Sections accessible per employee role. Super admin / admin see everything.
// Undefined roles = visible to all authenticated admins.
export const ROLE_SECTION_ACCESS: Record<string, string[]> = {
  operations_head: ["Dashboard","Zone Management","Trip Management","Promotion Management","User Management","Parcel Management","B2B / Porter","Vehicle Management","Fare Management","Transactions & Reports","Help & Support","Reviews","Business Management"],
  zone_head: ["Dashboard","Zone Management","Trip Management","User Management","Fare Management","Transactions & Reports","Help & Support","Reviews"],
  zone_manager: ["Dashboard","Zone Management","Trip Management","User Management","Fare Management"],
  driver_onboarding_exec: ["Dashboard","User Management","Vehicle Management"],
  support_agent: ["Dashboard","Trip Management","Help & Support","User Management"],
  marketing_exec: ["Dashboard","Promotion Management","User Management","Reviews"],
};

export const navSections: NavSection[] = [
  {
    category: "Dashboard",
    items: [
      { label: "Dashboard", icon: "bi-grid-fill", href: "/admin/dashboard" },
      { label: "Realtime Ops", icon: "bi-broadcast-pin", href: "/admin/realtime-ops" },
      { label: "System Health", icon: "bi-activity", href: "/admin/system-health" },
      { label: "Service Management", icon: "bi-toggles", href: "/admin/service-management" },
      { label: "Heat Map", icon: "bi-pin-map", href: "/admin/heat-map" },
      { label: "Fleet View", icon: "bi-map-fill", href: "/admin/fleet-view" },
    ],
  },
  {
    category: "Zone Management",
    items: [
      { label: "Zone Setup", icon: "bi-map", href: "/admin/zones" },
      { label: "Franchise Setup", icon: "bi-building", href: "/admin/franchisees" },
    ],
  },
  {
    category: "Trip Management",
    items: [
      { label: "All Trips", icon: "bi-car-front-fill", href: "/admin/trips" },
      { label: "Local Pool", icon: "bi-people-fill", href: "/admin/local-pool" },
      { label: "Intercity Pool", icon: "bi-car-front-fill", href: "/admin/intercity-pool" },
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

const ADMIN_ROUTE_ALIASES: Record<string, string> = {
  "/admin": "/admin/dashboard",
  "/admin/": "/admin/dashboard",
  "/admin/car-sharing": "/admin/local-pool",
  "/admin/intercity-carsharing": "/admin/intercity-pool",
};

export function normalizeAdminPath(path: string) {
  return ADMIN_ROUTE_ALIASES[path] || path;
}

export function isPrivilegedAdminRole(role?: string | null) {
  const normalized = String(role || "").toLowerCase().trim();
  return normalized === "admin" || normalized === "superadmin" || normalized === "super_admin";
}

export function getVisibleAdminNav(role?: string | null, search = "") {
  const normalizedRole = String(role || "").toLowerCase().trim();
  const allowedSections = isPrivilegedAdminRole(normalizedRole)
    ? null
    : new Set(ROLE_SECTION_ACCESS[normalizedRole] || []);
  const searchTerm = search.trim().toLowerCase();

  return navSections
    .filter((section) => !allowedSections || allowedSections.has(section.category))
    .map((section) => ({
      ...section,
      items: searchTerm
        ? section.items.filter((item) =>
            item.label.toLowerCase().includes(searchTerm) ||
            section.category.toLowerCase().includes(searchTerm) ||
            item.href.toLowerCase().includes(searchTerm)
          )
        : section.items,
    }))
    .filter((section) => section.items.length > 0);
}

export function canAccessAdminPath(role: string | undefined | null, path: string) {
  const normalizedPath = normalizeAdminPath(path);
  if (isPrivilegedAdminRole(role)) return true;
  const visibleNav = getVisibleAdminNav(role);
  return visibleNav.some((section) =>
    section.items.some((item) => normalizedPath === item.href || normalizedPath.startsWith(`${item.href}/`))
  );
}

export default function AdminLayout({ children }: { children: React.ReactNode }) {
  const cssReady = useAdminBootstrap();
  const [location, setLocation] = useLocation();
  const clock = useLiveClock();
  const { theme, setTheme } = useTheme();
  const isDark = theme === "dark";

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
  const [navSearch, setNavSearch] = useState("");
  const [notificationsOpen, setNotificationsOpen] = useState(false);
  const [authChecking, setAuthChecking] = useState(true);
  const [authError, setAuthError] = useState("");
  const [admin, setAdmin] = useState<AdminSession>(() => getSavedAdminSession());
  const userMenuRef = useRef<HTMLDivElement>(null);

  const adminName = admin.name || admin.email || "Admin";
  const adminInitials = adminName.split(" ").map((n: string) => n[0]).join("").substring(0, 2).toUpperCase();
  const adminBg = ["#2F7BFF","#7c3aed","#0891b2","#16a34a"][adminName.charCodeAt(0) % 4];

  useEffect(() => {
    let active = true;
    setAuthChecking(true);
    verifyAdminSession()
      .then((session) => {
        if (!active) return;
        setAdmin(session);
        setAuthError("");
      })
      .catch((error) => {
        if (!active) return;
        setAuthError(error?.message || "Admin session verification failed");
        window.location.replace("/admin/login");
      })
      .finally(() => {
        if (active) setAuthChecking(false);
      });

    const onAuthCleared = () => {
      if (!window.location.pathname.includes("/admin/login")) {
        window.location.replace("/admin/login");
      }
    };
    window.addEventListener("jago-admin-auth-cleared", onAuthCleared);
    return () => {
      active = false;
      window.removeEventListener("jago-admin-auth-cleared", onAuthCleared);
    };
  }, [setLocation]);

  const { data: notificationPayload } = useQuery<any>({
    queryKey: ["/api/notifications"],
    enabled: !authChecking && !!admin?.token,
    refetchInterval: 60_000,
    staleTime: 15_000,
  });

  const notifications = useMemo(() => {
    if (Array.isArray(notificationPayload)) return notificationPayload.slice(0, 5);
    if (Array.isArray(notificationPayload?.data)) return notificationPayload.data.slice(0, 5);
    if (Array.isArray(notificationPayload?.notifications)) return notificationPayload.notifications.slice(0, 5);
    return [];
  }, [notificationPayload]);

  useEffect(() => {
    if (!notificationsOpen) return;
    function handleClick(event: MouseEvent) {
      const target = event.target as HTMLElement;
      if (!target.closest("[data-admin-notifications]")) {
        setNotificationsOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [notificationsOpen]);

  // Auth is verified through /api/admin/me before the shell renders.

  useLayoutEffect(() => {
    document.body.classList.add("admin-route");
    return () => {
      document.body.classList.remove("admin-route", "aside-folded", "aside-open");
    };
  }, []);

  useLayoutEffect(() => {
    if (sidebarFolded) {
      document.body.classList.add("aside-folded");
    } else {
      document.body.classList.remove("aside-folded");
    }
    try { localStorage.setItem("jago-sidebar-folded", sidebarFolded ? "true" : "false"); }
    catch (_) {}
  }, [sidebarFolded]);

  useLayoutEffect(() => {
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

  const visibleNav = useMemo(() => getVisibleAdminNav(admin.role, navSearch), [admin.role, navSearch]);

  const handleLogout = async () => {
    await logoutAdminSession().catch(() => undefined);
    queryClient.clear();
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
        logoutAdminSession()
          .catch(() => undefined)
          .finally(() => {
            queryClient.clear();
            window.location.href = "/admin/login?reason=timeout";
          });
      }, TIMEOUT_MS);
    };

    const events = ["mousemove", "mousedown", "keydown", "touchstart", "scroll", "click"];
    events.forEach(e => window.addEventListener(e, reset, { passive: true }));
    reset(); // start timer immediately

    return () => {
      clearTimeout(timer);
      events.forEach(e => window.removeEventListener(e, reset));
    };
  }, [admin?.token]);

  // Wait for Bootstrap and verified auth before rendering admin chrome.
  if (!cssReady || authChecking || !admin?.token) {
    return (
      <div style={{
        minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center",
        background: "#f8fafc", flexDirection: "column", gap: 12
      }}>
        <Logo variant="blue" size="md" />
        <div style={{ fontSize: 13, color: "#64748b", fontWeight: 500 }}>
          {authError ? "Redirecting to secure login..." : "Verifying JAGO Admin session..."}
        </div>
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
                  onChange={(event) => setNavSearch(event.target.value)}
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
                <li className="px-3 py-2 text-white-50 small" style={{ listStyle: "none" }}>
                  No admin modules match "{navSearch}".
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
                  <div className="position-relative" data-admin-notifications>
                    <button
                      className="header-icon-btn"
                      data-testid="btn-notifications"
                      aria-expanded={notificationsOpen}
                      aria-haspopup="menu"
                      onClick={() => setNotificationsOpen((open) => !open)}
                    >
                      <i className="bi bi-bell-fill"></i>
                    </button>
                    {notifications.length > 0 && (
                      <span style={{
                        position: "absolute", top: 3, right: 3,
                        width: 7, height: 7, borderRadius: "50%",
                        background: "#ef4444", border: "1.5px solid white"
                      }}></span>
                    )}
                    {notificationsOpen && (
                      <div
                        className="dropdown-menu dropdown-menu-right show admin-user-dropdown"
                        role="menu"
                        style={{ width: 320, maxWidth: "calc(100vw - 32px)", padding: 8 }}
                      >
                        <div className="px-2 py-2 fw-bold" style={{ fontSize: 13 }}>Recent notifications</div>
                        {notifications.length === 0 ? (
                          <div className="px-2 py-3 text-muted small">No recent notification activity.</div>
                        ) : (
                          notifications.map((item: any, index: number) => (
                            <div key={item.id || index} className="px-2 py-2 rounded" style={{ borderBottom: index < notifications.length - 1 ? "1px solid #f1f5f9" : 0 }}>
                              <div className="fw-semibold" style={{ fontSize: 12 }}>{item.title || item.name || "Notification"}</div>
                              <div className="text-muted" style={{ fontSize: 11, lineHeight: 1.4 }}>
                                {item.message || item.body || item.description || "No message preview available."}
                              </div>
                            </div>
                          ))
                        )}
                        <Link href="/admin/notifications" className="dropdown-item rounded mt-1" onClick={() => setNotificationsOpen(false)}>
                          Open notification center
                        </Link>
                      </div>
                    )}
                  </div>
                </li>
                <li>
                  <div className="user admin-user-menu" ref={userMenuRef}>
                    <button
                      className="avatar avatar-sm rounded-circle header-avatar-btn"
                      onClick={() => setUserMenuOpen(!userMenuOpen)}
                      data-testid="btn-user-menu"
                      style={{ background: adminBg, fontSize: "0.75rem", fontWeight: 700, color: "#fff", letterSpacing: 0 }}
                    >
                      {adminInitials}
                    </button>
                    {userMenuOpen && (
                      <div className="dropdown-menu dropdown-menu-right show admin-user-dropdown">
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
          {children}
        </div>
      </div>
      <AdminConfirmHost />
    </div>
  );
}
