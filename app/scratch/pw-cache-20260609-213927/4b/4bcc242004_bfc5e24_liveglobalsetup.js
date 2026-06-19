import { LiveClient } from "./live-client";
import { runtime } from "./runtime";
import { readLiveSuiteState, writeLiveSuiteState } from "./live-suite-state";
export default async function globalSetup() {
  if (!runtime.useLiveBackend) return;
  const client = await LiveClient.create();
  try {
    try {
      const existing = await readLiveSuiteState();
      const ageMs = Date.now() - new Date(existing.createdAt).getTime();
      if (ageMs < 12 * 60 * 60 * 1000) {
        var _existing$actors$cust, _existing$actors$driv;
        const adminCheck = await client.get("/api/dashboard/stats", {
          Authorization: `Bearer ${existing.admin.session.token}`
        });
        if (adminCheck.status() === 401) {
          existing.admin.session = await client.loginAdmin();
        }
        if (!((_existing$actors$cust = existing.actors.customerSecondary) !== null && _existing$actors$cust !== void 0 && (_existing$actors$cust = _existing$actors$cust.session) !== null && _existing$actors$cust !== void 0 && _existing$actors$cust.token)) {
          existing.actors.customerSecondary = {
            label: "customer-secondary",
            phone: runtime.liveCustomerPhone2,
            session: await client.loginMobile(runtime.liveCustomerPhone2, "customer")
          };
        }
        if (!((_existing$actors$driv = existing.actors.driverAutoPrimary) !== null && _existing$actors$driv !== void 0 && (_existing$actors$driv = _existing$actors$driv.session) !== null && _existing$actors$driv !== void 0 && _existing$actors$driv.token)) {
          existing.actors.driverAutoPrimary = {
            label: "driver-auto-primary",
            phone: runtime.liveDriverAutoPhone,
            session: await client.loginMobile(runtime.liveDriverAutoPhone, "driver")
          };
        }
        await writeLiveSuiteState(existing);
        return;
      }
    } catch {
      // Fall through to a fresh bootstrap.
    }
    const state = await client.initializeSharedState();
    await writeLiveSuiteState(state);
  } finally {
    await client.dispose();
  }
}
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJuYW1lcyI6WyJMaXZlQ2xpZW50IiwicnVudGltZSIsInJlYWRMaXZlU3VpdGVTdGF0ZSIsIndyaXRlTGl2ZVN1aXRlU3RhdGUiLCJnbG9iYWxTZXR1cCIsInVzZUxpdmVCYWNrZW5kIiwiY2xpZW50IiwiY3JlYXRlIiwiZXhpc3RpbmciLCJhZ2VNcyIsIkRhdGUiLCJub3ciLCJjcmVhdGVkQXQiLCJnZXRUaW1lIiwiX2V4aXN0aW5nJGFjdG9ycyRjdXN0IiwiX2V4aXN0aW5nJGFjdG9ycyRkcml2IiwiYWRtaW5DaGVjayIsImdldCIsIkF1dGhvcml6YXRpb24iLCJhZG1pbiIsInNlc3Npb24iLCJ0b2tlbiIsInN0YXR1cyIsImxvZ2luQWRtaW4iLCJhY3RvcnMiLCJjdXN0b21lclNlY29uZGFyeSIsImxhYmVsIiwicGhvbmUiLCJsaXZlQ3VzdG9tZXJQaG9uZTIiLCJsb2dpbk1vYmlsZSIsImRyaXZlckF1dG9QcmltYXJ5IiwibGl2ZURyaXZlckF1dG9QaG9uZSIsInN0YXRlIiwiaW5pdGlhbGl6ZVNoYXJlZFN0YXRlIiwiZGlzcG9zZSJdLCJzb3VyY2VzIjpbImxpdmUtZ2xvYmFsLXNldHVwLnRzIl0sInNvdXJjZXNDb250ZW50IjpbImltcG9ydCB7IExpdmVDbGllbnQgfSBmcm9tIFwiLi9saXZlLWNsaWVudFwiO1xyXG5pbXBvcnQgeyBydW50aW1lIH0gZnJvbSBcIi4vcnVudGltZVwiO1xyXG5pbXBvcnQgeyByZWFkTGl2ZVN1aXRlU3RhdGUsIHdyaXRlTGl2ZVN1aXRlU3RhdGUgfSBmcm9tIFwiLi9saXZlLXN1aXRlLXN0YXRlXCI7XHJcblxyXG5leHBvcnQgZGVmYXVsdCBhc3luYyBmdW5jdGlvbiBnbG9iYWxTZXR1cCgpIHtcclxuICBpZiAoIXJ1bnRpbWUudXNlTGl2ZUJhY2tlbmQpIHJldHVybjtcclxuXHJcbiAgY29uc3QgY2xpZW50ID0gYXdhaXQgTGl2ZUNsaWVudC5jcmVhdGUoKTtcclxuICB0cnkge1xyXG4gICAgdHJ5IHtcclxuICAgICAgY29uc3QgZXhpc3RpbmcgPSBhd2FpdCByZWFkTGl2ZVN1aXRlU3RhdGUoKTtcclxuICAgICAgY29uc3QgYWdlTXMgPSBEYXRlLm5vdygpIC0gbmV3IERhdGUoZXhpc3RpbmcuY3JlYXRlZEF0KS5nZXRUaW1lKCk7XHJcbiAgICAgIGlmIChhZ2VNcyA8IDEyICogNjAgKiA2MCAqIDEwMDApIHtcclxuICAgICAgICBjb25zdCBhZG1pbkNoZWNrID0gYXdhaXQgY2xpZW50LmdldChcIi9hcGkvZGFzaGJvYXJkL3N0YXRzXCIsIHtcclxuICAgICAgICAgIEF1dGhvcml6YXRpb246IGBCZWFyZXIgJHtleGlzdGluZy5hZG1pbi5zZXNzaW9uLnRva2VufWAsXHJcbiAgICAgICAgfSk7XHJcbiAgICAgICAgaWYgKGFkbWluQ2hlY2suc3RhdHVzKCkgPT09IDQwMSkge1xyXG4gICAgICAgICAgZXhpc3RpbmcuYWRtaW4uc2Vzc2lvbiA9IGF3YWl0IGNsaWVudC5sb2dpbkFkbWluKCk7XHJcbiAgICAgICAgfVxyXG4gICAgICAgIGlmICghZXhpc3RpbmcuYWN0b3JzLmN1c3RvbWVyU2Vjb25kYXJ5Py5zZXNzaW9uPy50b2tlbikge1xyXG4gICAgICAgICAgZXhpc3RpbmcuYWN0b3JzLmN1c3RvbWVyU2Vjb25kYXJ5ID0ge1xyXG4gICAgICAgICAgICBsYWJlbDogXCJjdXN0b21lci1zZWNvbmRhcnlcIixcclxuICAgICAgICAgICAgcGhvbmU6IHJ1bnRpbWUubGl2ZUN1c3RvbWVyUGhvbmUyLFxyXG4gICAgICAgICAgICBzZXNzaW9uOiBhd2FpdCBjbGllbnQubG9naW5Nb2JpbGUocnVudGltZS5saXZlQ3VzdG9tZXJQaG9uZTIsIFwiY3VzdG9tZXJcIiksXHJcbiAgICAgICAgICB9O1xyXG4gICAgICAgIH1cclxuICAgICAgICBpZiAoIWV4aXN0aW5nLmFjdG9ycy5kcml2ZXJBdXRvUHJpbWFyeT8uc2Vzc2lvbj8udG9rZW4pIHtcclxuICAgICAgICAgIGV4aXN0aW5nLmFjdG9ycy5kcml2ZXJBdXRvUHJpbWFyeSA9IHtcclxuICAgICAgICAgICAgbGFiZWw6IFwiZHJpdmVyLWF1dG8tcHJpbWFyeVwiLFxyXG4gICAgICAgICAgICBwaG9uZTogcnVudGltZS5saXZlRHJpdmVyQXV0b1Bob25lLFxyXG4gICAgICAgICAgICBzZXNzaW9uOiBhd2FpdCBjbGllbnQubG9naW5Nb2JpbGUocnVudGltZS5saXZlRHJpdmVyQXV0b1Bob25lLCBcImRyaXZlclwiKSxcclxuICAgICAgICAgIH07XHJcbiAgICAgICAgfVxyXG4gICAgICAgIGF3YWl0IHdyaXRlTGl2ZVN1aXRlU3RhdGUoZXhpc3RpbmcpO1xyXG4gICAgICAgIHJldHVybjtcclxuICAgICAgfVxyXG4gICAgfSBjYXRjaCB7XHJcbiAgICAgIC8vIEZhbGwgdGhyb3VnaCB0byBhIGZyZXNoIGJvb3RzdHJhcC5cclxuICAgIH1cclxuXHJcbiAgICBjb25zdCBzdGF0ZSA9IGF3YWl0IGNsaWVudC5pbml0aWFsaXplU2hhcmVkU3RhdGUoKTtcclxuICAgIGF3YWl0IHdyaXRlTGl2ZVN1aXRlU3RhdGUoc3RhdGUpO1xyXG4gIH0gZmluYWxseSB7XHJcbiAgICBhd2FpdCBjbGllbnQuZGlzcG9zZSgpO1xyXG4gIH1cclxufVxyXG4iXSwibWFwcGluZ3MiOiJBQUFBLFNBQVNBLFVBQVUsUUFBUSxlQUFlO0FBQzFDLFNBQVNDLE9BQU8sUUFBUSxXQUFXO0FBQ25DLFNBQVNDLGtCQUFrQixFQUFFQyxtQkFBbUIsUUFBUSxvQkFBb0I7QUFFNUUsZUFBZSxlQUFlQyxXQUFXQSxDQUFBLEVBQUc7RUFDMUMsSUFBSSxDQUFDSCxPQUFPLENBQUNJLGNBQWMsRUFBRTtFQUU3QixNQUFNQyxNQUFNLEdBQUcsTUFBTU4sVUFBVSxDQUFDTyxNQUFNLENBQUMsQ0FBQztFQUN4QyxJQUFJO0lBQ0YsSUFBSTtNQUNGLE1BQU1DLFFBQVEsR0FBRyxNQUFNTixrQkFBa0IsQ0FBQyxDQUFDO01BQzNDLE1BQU1PLEtBQUssR0FBR0MsSUFBSSxDQUFDQyxHQUFHLENBQUMsQ0FBQyxHQUFHLElBQUlELElBQUksQ0FBQ0YsUUFBUSxDQUFDSSxTQUFTLENBQUMsQ0FBQ0MsT0FBTyxDQUFDLENBQUM7TUFDakUsSUFBSUosS0FBSyxHQUFHLEVBQUUsR0FBRyxFQUFFLEdBQUcsRUFBRSxHQUFHLElBQUksRUFBRTtRQUFBLElBQUFLLHFCQUFBLEVBQUFDLHFCQUFBO1FBQy9CLE1BQU1DLFVBQVUsR0FBRyxNQUFNVixNQUFNLENBQUNXLEdBQUcsQ0FBQyxzQkFBc0IsRUFBRTtVQUMxREMsYUFBYSxFQUFFLFVBQVVWLFFBQVEsQ0FBQ1csS0FBSyxDQUFDQyxPQUFPLENBQUNDLEtBQUs7UUFDdkQsQ0FBQyxDQUFDO1FBQ0YsSUFBSUwsVUFBVSxDQUFDTSxNQUFNLENBQUMsQ0FBQyxLQUFLLEdBQUcsRUFBRTtVQUMvQmQsUUFBUSxDQUFDVyxLQUFLLENBQUNDLE9BQU8sR0FBRyxNQUFNZCxNQUFNLENBQUNpQixVQUFVLENBQUMsQ0FBQztRQUNwRDtRQUNBLElBQUksR0FBQVQscUJBQUEsR0FBQ04sUUFBUSxDQUFDZ0IsTUFBTSxDQUFDQyxpQkFBaUIsY0FBQVgscUJBQUEsZ0JBQUFBLHFCQUFBLEdBQWpDQSxxQkFBQSxDQUFtQ00sT0FBTyxjQUFBTixxQkFBQSxlQUExQ0EscUJBQUEsQ0FBNENPLEtBQUssR0FBRTtVQUN0RGIsUUFBUSxDQUFDZ0IsTUFBTSxDQUFDQyxpQkFBaUIsR0FBRztZQUNsQ0MsS0FBSyxFQUFFLG9CQUFvQjtZQUMzQkMsS0FBSyxFQUFFMUIsT0FBTyxDQUFDMkIsa0JBQWtCO1lBQ2pDUixPQUFPLEVBQUUsTUFBTWQsTUFBTSxDQUFDdUIsV0FBVyxDQUFDNUIsT0FBTyxDQUFDMkIsa0JBQWtCLEVBQUUsVUFBVTtVQUMxRSxDQUFDO1FBQ0g7UUFDQSxJQUFJLEdBQUFiLHFCQUFBLEdBQUNQLFFBQVEsQ0FBQ2dCLE1BQU0sQ0FBQ00saUJBQWlCLGNBQUFmLHFCQUFBLGdCQUFBQSxxQkFBQSxHQUFqQ0EscUJBQUEsQ0FBbUNLLE9BQU8sY0FBQUwscUJBQUEsZUFBMUNBLHFCQUFBLENBQTRDTSxLQUFLLEdBQUU7VUFDdERiLFFBQVEsQ0FBQ2dCLE1BQU0sQ0FBQ00saUJBQWlCLEdBQUc7WUFDbENKLEtBQUssRUFBRSxxQkFBcUI7WUFDNUJDLEtBQUssRUFBRTFCLE9BQU8sQ0FBQzhCLG1CQUFtQjtZQUNsQ1gsT0FBTyxFQUFFLE1BQU1kLE1BQU0sQ0FBQ3VCLFdBQVcsQ0FBQzVCLE9BQU8sQ0FBQzhCLG1CQUFtQixFQUFFLFFBQVE7VUFDekUsQ0FBQztRQUNIO1FBQ0EsTUFBTTVCLG1CQUFtQixDQUFDSyxRQUFRLENBQUM7UUFDbkM7TUFDRjtJQUNGLENBQUMsQ0FBQyxNQUFNO01BQ047SUFBQTtJQUdGLE1BQU13QixLQUFLLEdBQUcsTUFBTTFCLE1BQU0sQ0FBQzJCLHFCQUFxQixDQUFDLENBQUM7SUFDbEQsTUFBTTlCLG1CQUFtQixDQUFDNkIsS0FBSyxDQUFDO0VBQ2xDLENBQUMsU0FBUztJQUNSLE1BQU0xQixNQUFNLENBQUM0QixPQUFPLENBQUMsQ0FBQztFQUN4QjtBQUNGIiwiaWdub3JlTGlzdCI6W119