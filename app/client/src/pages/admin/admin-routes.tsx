import { lazy, Suspense, useEffect } from "react";
import { Switch, Route, Redirect, useLocation } from "wouter";
import AdminLayout from "@/pages/admin/layout";

function preloadStylesheet(id: string, href: string) {
  if (document.getElementById(id)) return;
  const link = document.createElement("link");
  link.id = id;
  link.rel = "stylesheet";
  link.href = href;
  document.head.appendChild(link);
}

function preloadScript(id: string, src: string) {
  if (document.getElementById(id) || document.querySelector(`script[src="${src}"]`)) return;
  const script = document.createElement("script");
  script.id = id;
  script.src = src;
  script.async = true;
  document.head.appendChild(script);
}

function preloadHeatMapAssets() {
  preloadStylesheet("admin-leaflet-css", "https://unpkg.com/leaflet@1.9.4/dist/leaflet.css");
  preloadScript("admin-leaflet-js", "https://unpkg.com/leaflet@1.9.4/dist/leaflet.js");
  preloadScript("admin-leaflet-heat-js", "https://unpkg.com/leaflet.heat@0.2.0/dist/leaflet-heat.js");
}

const loadDashboard = () => import("@/pages/admin/dashboard");
const loadTrips = () => import("@/pages/admin/trips");
const loadCustomers = () => import("@/pages/admin/customers");
const loadDrivers = () => import("@/pages/admin/drivers");
const loadVehicleCategories = () => import("@/pages/admin/vehicle-categories");
const loadZones = () => import("@/pages/admin/zones");
const loadFares = () => import("@/pages/admin/fares");
const loadTransactions = () => import("@/pages/admin/transactions");
const loadCoupons = () => import("@/pages/admin/coupons");
const loadReviews = () => import("@/pages/admin/reviews");
const loadSettings = () => import("@/pages/admin/settings");
const loadBlogsPage = () => import("@/pages/admin/blogs");
const loadWithdrawals = () => import("@/pages/admin/withdrawals");
const loadCancellationReasonsPage = () => import("@/pages/admin/cancellation-reasons");
const loadHeatMap = () => import("@/pages/admin/heat-map");
const loadRealtimeOps = () => import("@/pages/admin/realtime-ops");
const loadFleetView = () => import("@/pages/admin/fleet-view");
const loadCarSharing = () => import("@/pages/admin/car-sharing");
const loadParcelRefunds = () => import("@/pages/admin/parcel-refunds");
const loadSafetyAlerts = () => import("@/pages/admin/safety-alerts");
const loadAlertEngine = () => import("@/pages/admin/alert-engine");
const loadBanners = () => import("@/pages/admin/banners");
const loadDiscounts = () => import("@/pages/admin/discounts");
const loadSpinWheel = () => import("@/pages/admin/spin-wheel");
const loadNotifications = () => import("@/pages/admin/notifications");
const loadDriverLevels = () => import("@/pages/admin/driver-levels");
const loadCustomerLevels = () => import("@/pages/admin/customer-levels");
const loadCustomerWallet = () => import("@/pages/admin/customer-wallet");
const loadWalletBonus = () => import("@/pages/admin/wallet-bonus");
const loadEmployees = () => import("@/pages/admin/employees");
const loadNewsletter = () => import("@/pages/admin/newsletter");
const loadSubscriptions = () => import("@/pages/admin/subscriptions");
const loadRevenueModel = () => import("@/pages/admin/revenue-model");
const loadDriverWalletPage = () => import("@/pages/admin/driver-wallet");
const loadRefundRequestsPage = () => import("@/pages/admin/refund-requests");
const loadApiDocsPage = () => import("@/pages/admin/api-docs");
const loadAppDesignPage = () => import("@/pages/admin/app-design");
const loadLanguagesPage = () => import("@/pages/admin/languages");
const loadServiceManagement = () => import("@/pages/admin/service-management");
const loadParcelAttributes = () => import("@/pages/admin/parcel-attributes");
const loadVehicleAttributes = () => import("@/pages/admin/vehicle-attributes");
const loadVehicleRequests = () => import("@/pages/admin/vehicle-requests");
const loadParcelFares = () => import("@/pages/admin/parcel-fares");
const loadSurgePricing = () => import("@/pages/admin/surge-pricing");
const loadReports = () => import("@/pages/admin/reports");
const loadChatting = () => import("@/pages/admin/chatting");
const loadCallLogs = () => import("@/pages/admin/call-logs");
const loadBusinessSetup = () => import("@/pages/admin/business-setup");
const loadPagesMedia = () => import("@/pages/admin/pages-media");
const loadConfigurations = () => import("@/pages/admin/configurations");
const loadB2BCompanies = () => import("@/pages/admin/b2b-companies");
const loadIntercityRoutes = () => import("@/pages/admin/intercity-routes");
const loadInsurance = () => import("@/pages/admin/insurance");
const loadDriverEarnings = () => import("@/pages/admin/driver-earnings");
const loadReferrals = () => import("@/pages/admin/referrals");
const loadDriverVerificationPage = () => import("@/pages/admin/driver-verification");
const loadLocalPool = () => import("@/pages/admin/local-pool");
const loadOutstationPool = () => import("@/pages/admin/outstation-pool");
const loadParcelOrders = () => import("@/pages/admin/parcel-orders");
const loadSystemHealth = () => import("@/pages/admin/system-health");
const loadVoiceCommandsPage = () => import("@/pages/admin/voice-commands");
const loadCityServices = () => import("@/pages/admin/city-services");
const loadParcelVehiclesAdmin = () => import("@/pages/admin/parcel-vehicles");
const loadAIBrainDashboard = () => import("@/pages/admin/ai-brain-dashboard");

const Dashboard = lazy(loadDashboard);
const Trips = lazy(loadTrips);
const Customers = lazy(loadCustomers);
const Drivers = lazy(loadDrivers);
const VehicleCategories = lazy(loadVehicleCategories);
const Zones = lazy(loadZones);
const Fares = lazy(loadFares);
const Transactions = lazy(loadTransactions);
const Coupons = lazy(loadCoupons);
const Reviews = lazy(loadReviews);
const Settings = lazy(loadSettings);
const BlogsPage = lazy(loadBlogsPage);
const Withdrawals = lazy(loadWithdrawals);
const CancellationReasonsPage = lazy(loadCancellationReasonsPage);
const HeatMap = lazy(loadHeatMap);
const RealtimeOps = lazy(loadRealtimeOps);
const FleetView = lazy(loadFleetView);
const CarSharing = lazy(loadCarSharing);
const ParcelRefunds = lazy(loadParcelRefunds);
const SafetyAlerts = lazy(loadSafetyAlerts);
const AlertEngine = lazy(loadAlertEngine);
const Banners = lazy(loadBanners);
const Discounts = lazy(loadDiscounts);
const SpinWheel = lazy(loadSpinWheel);
const Notifications = lazy(loadNotifications);
const DriverLevels = lazy(loadDriverLevels);
const CustomerLevels = lazy(loadCustomerLevels);
const CustomerWallet = lazy(loadCustomerWallet);
const WalletBonus = lazy(loadWalletBonus);
const Employees = lazy(loadEmployees);
const Newsletter = lazy(loadNewsletter);
const Subscriptions = lazy(loadSubscriptions);
const RevenueModel = lazy(loadRevenueModel);
const DriverWalletPage = lazy(loadDriverWalletPage);
const RefundRequestsPage = lazy(loadRefundRequestsPage);
const ApiDocsPage = lazy(loadApiDocsPage);
const AppDesignPage = lazy(loadAppDesignPage);
const LanguagesPage = lazy(loadLanguagesPage);
const ServiceManagement = lazy(loadServiceManagement);
const ParcelAttributes = lazy(loadParcelAttributes);
const VehicleAttributes = lazy(loadVehicleAttributes);
const VehicleRequests = lazy(loadVehicleRequests);
const ParcelFares = lazy(loadParcelFares);
const SurgePricing = lazy(loadSurgePricing);
const Reports = lazy(loadReports);
const Chatting = lazy(loadChatting);
const CallLogs = lazy(loadCallLogs);
const BusinessSetup = lazy(loadBusinessSetup);
const PagesMedia = lazy(loadPagesMedia);
const Configurations = lazy(loadConfigurations);
const B2BCompanies = lazy(loadB2BCompanies);
const IntercityRoutes = lazy(loadIntercityRoutes);
const Insurance = lazy(loadInsurance);
const DriverEarnings = lazy(loadDriverEarnings);
const Referrals = lazy(loadReferrals);
const DriverVerificationPage = lazy(loadDriverVerificationPage);
const LocalPool = lazy(loadLocalPool);
const OutstationPool = lazy(loadOutstationPool);
const ParcelOrders = lazy(loadParcelOrders);
const SystemHealth = lazy(loadSystemHealth);
const VoiceCommandsPage = lazy(loadVoiceCommandsPage);
const CityServices = lazy(loadCityServices);
const ParcelVehiclesAdmin = lazy(loadParcelVehiclesAdmin);
const AIBrainDashboard = lazy(loadAIBrainDashboard);

const preloadAdminModules = [
  loadDashboard,
  loadTrips,
  loadCustomers,
  loadDrivers,
  loadZones,
  loadHeatMap,
  loadFleetView,
  loadRealtimeOps,
  loadSystemHealth,
  loadServiceManagement,
  loadDiscounts,
  loadCoupons,
  loadReports,
  loadChatting,
];

function AdminPageFallback() {
  return (
    <div className="admin-page-loading" aria-live="polite">
      <div className="admin-page-loading__bar" />
      <div className="admin-page-loading__text">Opening module...</div>
    </div>
  );
}

function AdminRouteMissing() {
  return (
    <div className="d-flex flex-column align-items-center justify-content-center py-5 text-center">
      <div className="rounded-circle d-inline-flex align-items-center justify-content-center mb-3" style={{ width: 64, height: 64, background: "#eff6ff", color: "#2563eb" }}>
        <i className="bi bi-exclamation-diamond-fill fs-3"></i>
      </div>
      <h2 className="h4 fw-bold mb-2">Module Not Found</h2>
      <p className="text-muted mb-0">This admin route is not mapped to a live module in the current build.</p>
    </div>
  );
}

export default function AdminRoutes() {
  const [location] = useLocation();

  useEffect(() => {
    const run = () => {
      preloadHeatMapAssets();
      preloadAdminModules.forEach((loader, index) => {
        setTimeout(() => {
          loader().catch(() => undefined);
        }, index * 80);
      });
    };

    if ("requestIdleCallback" in window) {
      const idleId = (window as any).requestIdleCallback(run, { timeout: 1200 });
      return () => (window as any).cancelIdleCallback?.(idleId);
    }

    const timeoutId = setTimeout(run, 500);
    return () => clearTimeout(timeoutId);
  }, []);

  useEffect(() => {
    window.scrollTo({ top: 0, left: 0, behavior: "auto" });
    document.documentElement.scrollTop = 0;
    document.body.scrollTop = 0;
    document.querySelectorAll(".main-area, .admin-main-area, .main-area-inner, .admin-main-inner").forEach((node) => {
      if (node instanceof HTMLElement) {
        node.scrollTop = 0;
        node.scrollLeft = 0;
      }
    });
  }, [location]);

  return (
    <AdminLayout>
      <Suspense fallback={<AdminPageFallback />}>
        <Switch>
          <Route path="/admin/dashboard" component={Dashboard} />
          <Route path="/admin/realtime-ops" component={RealtimeOps} />
          <Route path="/admin/heat-map" component={HeatMap} />
          <Route path="/admin/fleet-view" component={FleetView} />
          <Route path="/admin/zones" component={Zones} />
          <Route path="/admin/popular-locations">
            <Redirect to="/admin/zones" />
          </Route>
          <Route path="/admin/trips" component={Trips} />
          <Route path="/admin/intercity-pool" component={CarSharing} />
          <Route path="/admin/local-pool" component={LocalPool} />
          <Route path="/admin/outstation-pool" component={OutstationPool} />
          <Route path="/admin/parcel-refunds" component={ParcelRefunds} />
          <Route path="/admin/safety-alerts" component={SafetyAlerts} />
          <Route path="/admin/alert-engine" component={AlertEngine} />
          <Route path="/admin/banners" component={Banners} />
          <Route path="/admin/coupons" component={Coupons} />
          <Route path="/admin/discounts" component={Discounts} />
          <Route path="/admin/spin-wheel" component={SpinWheel} />
          <Route path="/admin/notifications" component={Notifications} />
          <Route path="/admin/driver-levels" component={DriverLevels} />
          <Route path="/admin/driver-verification" component={DriverVerificationPage} />
          <Route path="/admin/drivers" component={Drivers} />
          <Route path="/admin/withdrawals" component={Withdrawals} />
          <Route path="/admin/customer-levels" component={CustomerLevels} />
          <Route path="/admin/customers" component={Customers} />
          <Route path="/admin/customer-wallet" component={CustomerWallet} />
          <Route path="/admin/wallet-bonus" component={WalletBonus} />
          <Route path="/admin/employees" component={Employees} />
          <Route path="/admin/newsletter" component={Newsletter} />
          <Route path="/admin/subscriptions" component={Subscriptions} />
          <Route path="/admin/revenue-model" component={RevenueModel} />
          <Route path="/admin/parcel-attributes" component={ParcelAttributes} />
          <Route path="/admin/vehicle-attributes" component={VehicleAttributes} />
          <Route path="/admin/vehicles" component={VehicleCategories} />
          <Route path="/admin/vehicle-requests" component={VehicleRequests} />
          <Route path="/admin/fares" component={Fares} />
          <Route path="/admin/cancellation-reasons" component={CancellationReasonsPage} />
          <Route path="/admin/parcel-fares" component={ParcelFares} />
          <Route path="/admin/surge-pricing" component={SurgePricing} />
          <Route path="/admin/transactions" component={Transactions} />
          <Route path="/admin/reports" component={Reports} />
          <Route path="/admin/chatting" component={Chatting} />
          <Route path="/admin/call-logs" component={CallLogs} />
          <Route path="/admin/blogs" component={BlogsPage} />
          <Route path="/admin/reviews" component={Reviews} />
          <Route path="/admin/business-setup" component={BusinessSetup} />
          <Route path="/admin/pages-media" component={PagesMedia} />
          <Route path="/admin/configurations" component={Configurations} />
          <Route path="/admin/settings" component={Settings} />
          <Route path="/admin/b2b-companies" component={B2BCompanies} />
          <Route path="/admin/intercity-routes" component={IntercityRoutes} />
          <Route path="/admin/insurance" component={Insurance} />
          <Route path="/admin/driver-earnings" component={DriverEarnings} />
          <Route path="/admin/driver-wallet" component={DriverWalletPage} />
          <Route path="/admin/refund-requests" component={RefundRequestsPage} />
          <Route path="/admin/api-docs" component={ApiDocsPage} />
          <Route path="/admin/app-design" component={AppDesignPage} />
          <Route path="/admin/languages" component={LanguagesPage} />
          <Route path="/admin/service-management" component={ServiceManagement} />
          <Route path="/admin/parcel-orders" component={ParcelOrders} />
          <Route path="/admin/system-health" component={SystemHealth} />
          <Route path="/admin/voice-commands" component={VoiceCommandsPage} />
          <Route path="/admin/referrals" component={Referrals} />
          <Route path="/admin/city-services" component={CityServices} />
          <Route path="/admin/parcel-vehicle-types" component={ParcelVehiclesAdmin} />
          <Route path="/admin/ai-brain" component={AIBrainDashboard} />
          <Route component={AdminRouteMissing} />
        </Switch>
      </Suspense>
    </AdminLayout>
  );
}
