import { lazy } from "react";
import { Switch, Route, Redirect } from "wouter";
import AdminLayout from "@/pages/admin/layout";

const Dashboard = lazy(() => import("@/pages/admin/dashboard"));
const Trips = lazy(() => import("@/pages/admin/trips"));
const Customers = lazy(() => import("@/pages/admin/customers"));
const Drivers = lazy(() => import("@/pages/admin/drivers"));
const VehicleCategories = lazy(() => import("@/pages/admin/vehicle-categories"));
const Zones = lazy(() => import("@/pages/admin/zones"));
const Fares = lazy(() => import("@/pages/admin/fares"));
const Transactions = lazy(() => import("@/pages/admin/transactions"));
const Coupons = lazy(() => import("@/pages/admin/coupons"));
const Reviews = lazy(() => import("@/pages/admin/reviews"));
const Settings = lazy(() => import("@/pages/admin/settings"));
const BlogsPage = lazy(() => import("@/pages/admin/blogs"));
const Withdrawals = lazy(() => import("@/pages/admin/withdrawals"));
const CancellationReasonsPage = lazy(() => import("@/pages/admin/cancellation-reasons"));
const HeatMap = lazy(() => import("@/pages/admin/heat-map"));
const FleetView = lazy(() => import("@/pages/admin/fleet-view"));
const CarSharing = lazy(() => import("@/pages/admin/car-sharing"));
const IntercityCarSharing = lazy(() => import("@/pages/admin/intercity-carsharing"));
const ParcelRefunds = lazy(() => import("@/pages/admin/parcel-refunds"));
const SafetyAlerts = lazy(() => import("@/pages/admin/safety-alerts"));
const Banners = lazy(() => import("@/pages/admin/banners"));
const Discounts = lazy(() => import("@/pages/admin/discounts"));
const SpinWheel = lazy(() => import("@/pages/admin/spin-wheel"));
const Notifications = lazy(() => import("@/pages/admin/notifications"));
const DriverLevels = lazy(() => import("@/pages/admin/driver-levels"));
const CustomerLevels = lazy(() => import("@/pages/admin/customer-levels"));
const CustomerWallet = lazy(() => import("@/pages/admin/customer-wallet"));
const WalletBonus = lazy(() => import("@/pages/admin/wallet-bonus"));
const Employees = lazy(() => import("@/pages/admin/employees"));
const Newsletter = lazy(() => import("@/pages/admin/newsletter"));
const Subscriptions = lazy(() => import("@/pages/admin/subscriptions"));
const RevenueModel = lazy(() => import("@/pages/admin/revenue-model"));
const DriverWalletPage = lazy(() => import("@/pages/admin/driver-wallet"));
const RefundRequestsPage = lazy(() => import("@/pages/admin/refund-requests"));
const ApiDocsPage = lazy(() => import("@/pages/admin/api-docs"));
const AppDesignPage = lazy(() => import("@/pages/admin/app-design"));
const LanguagesPage = lazy(() => import("@/pages/admin/languages"));
const ServiceManagement = lazy(() => import("@/pages/admin/service-management"));
const ParcelAttributes = lazy(() => import("@/pages/admin/parcel-attributes"));
const VehicleAttributes = lazy(() => import("@/pages/admin/vehicle-attributes"));
const VehicleRequests = lazy(() => import("@/pages/admin/vehicle-requests"));
const ParcelFares = lazy(() => import("@/pages/admin/parcel-fares"));
const SurgePricing = lazy(() => import("@/pages/admin/surge-pricing"));
const Reports = lazy(() => import("@/pages/admin/reports"));
const Chatting = lazy(() => import("@/pages/admin/chatting"));
const CallLogs = lazy(() => import("@/pages/admin/call-logs"));
const BusinessSetup = lazy(() => import("@/pages/admin/business-setup"));
const PagesMedia = lazy(() => import("@/pages/admin/pages-media"));
const Configurations = lazy(() => import("@/pages/admin/configurations"));
const B2BCompanies = lazy(() => import("@/pages/admin/b2b-companies"));
const IntercityRoutes = lazy(() => import("@/pages/admin/intercity-routes"));
const Insurance = lazy(() => import("@/pages/admin/insurance"));
const DriverEarnings = lazy(() => import("@/pages/admin/driver-earnings"));
const Referrals = lazy(() => import("@/pages/admin/referrals"));
const DriverVerificationPage = lazy(() => import("@/pages/admin/driver-verification"));
const OutstationPool = lazy(() => import("@/pages/admin/outstation-pool"));
const ParcelOrders = lazy(() => import("@/pages/admin/parcel-orders"));
const SystemHealth = lazy(() => import("@/pages/admin/system-health"));
const VoiceCommandsPage = lazy(() => import("@/pages/admin/voice-commands"));
const PopularLocationsAdmin = lazy(() => import("@/pages/admin/popular-locations"));
const CityServices = lazy(() => import("@/pages/admin/city-services"));
const ParcelVehiclesAdmin = lazy(() => import("@/pages/admin/parcel-vehicles"));
const AIBrainDashboard = lazy(() => import("@/pages/admin/ai-brain-dashboard"));

export default function AdminRoutes() {
  return (
    <AdminLayout>
      <Switch>
        <Route path="/admin/dashboard" component={Dashboard} />
        <Route path="/admin/heat-map" component={HeatMap} />
        <Route path="/admin/fleet-view" component={FleetView} />
        <Route path="/admin/zones" component={Zones} />
        <Route path="/admin/trips" component={Trips} />
        <Route path="/admin/car-sharing" component={CarSharing} />
        <Route path="/admin/intercity-carsharing" component={IntercityCarSharing} />
        <Route path="/admin/outstation-pool" component={OutstationPool} />
        <Route path="/admin/parcel-refunds" component={ParcelRefunds} />
        <Route path="/admin/safety-alerts" component={SafetyAlerts} />
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
        <Route path="/admin/popular-locations" component={PopularLocationsAdmin} />
        <Route path="/admin/city-services" component={CityServices} />
        <Route path="/admin/parcel-vehicle-types" component={ParcelVehiclesAdmin} />
        <Route path="/admin/ai-brain" component={AIBrainDashboard} />
        <Route><Redirect to="/admin/dashboard" /></Route>
      </Switch>
    </AdminLayout>
  );
}
