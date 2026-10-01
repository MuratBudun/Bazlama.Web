using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using static Bazlama.Tests.TestHost;

namespace Bazlama.Tests.Management;

public sealed class ManagementTests : IAsyncLifetime
{
    readonly TestHost host = new();
    HttpClient admin = null!;

    public async ValueTask InitializeAsync()
    {
        await host.SetupAsync();
        admin = host.Client();
        Assert.Equal("active", (await admin.LoginAsync(AdminUser, AdminPassword)).Status());
    }

    public ValueTask DisposeAsync() => host.DisposeAsync();

    const string UserPassword = "Kullanici2026x";

    async Task<Guid> CreateUserAsync(string userName)
    {
        var res = await admin.PostAsJsonAsync("/api/management/users",
            new { userName, displayName = userName.ToUpperInvariant(), password = UserPassword, mustChangePassword = false }, Ct);
        Assert.Equal(HttpStatusCode.OK, res.StatusCode);
        return (await res.JsonAsync()).GetProperty("id").GetGuid();
    }

    async Task<JsonElement> OrganizationAsync() => await (await admin.GetAsync("/api/management/organization", Ct)).JsonAsync();

    async Task<Guid> PostIdAsync(string path, object body)
    {
        var res = await admin.PostAsJsonAsync(path, body, Ct);
        Assert.Equal(HttpStatusCode.OK, res.StatusCode);
        return (await res.JsonAsync()).GetProperty("id").GetGuid();
    }

    [Fact]
    public async Task Without_permission_management_is_forbidden()
    {
        var id = await CreateUserAsync("ayse");
        var company = (await OrganizationAsync())[0].GetProperty("id").GetGuid();
        await admin.PutAsJsonAsync($"/api/management/users/{id}/access", new[] { new { companyId = company } }, Ct);

        var ayse = host.Client();
        Assert.Equal("active", (await ayse.LoginAsync("ayse", UserPassword)).Status());
        Assert.Equal(HttpStatusCode.Forbidden, (await ayse.GetAsync("/api/management/users", Ct)).StatusCode);
    }

    [Fact]
    public async Task A_location_bound_group_grants_its_permissions_only_in_that_location_and_changes_apply_at_once()
    {
        var org = await OrganizationAsync();
        var company = org[0].GetProperty("id").GetGuid();
        var merkez = org[0].GetProperty("locations")[0].GetProperty("id").GetGuid();
        var fabrika = await PostIdAsync("/api/management/organization/locations", new { companyId = company, code = "FAB", name = "Fabrika", isActive = true });

        var group = await PostIdAsync("/api/management/groups", new { code = "audit-readers", name = "Audit okuyucular", requireMfa = false });
        Assert.Equal(HttpStatusCode.NoContent, (await admin.PutAsJsonAsync($"/api/management/groups/{group}/permissions", new[] { "system.audit" }, Ct)).StatusCode);

        var id = await CreateUserAsync("mehmet");
        await admin.PutAsJsonAsync($"/api/management/users/{id}/access", new[] { new { companyId = company } }, Ct);
        await admin.PutAsJsonAsync($"/api/management/users/{id}/groups", new[] { new { groupId = group, locationId = (Guid?)fabrika } }, Ct);

        var mehmet = host.Client();
        var me = await mehmet.LoginAsync("mehmet", UserPassword);
        // Two locations: no context is chosen for him.
        Assert.True(me.GetProperty("contextRequired").GetBoolean());

        await mehmet.PutAsJsonAsync("/api/auth/context", new { companyId = company, locationId = merkez }, Ct);
        Assert.Equal(HttpStatusCode.Forbidden, (await mehmet.GetAsync("/api/management/audit", Ct)).StatusCode);
        await mehmet.PutAsJsonAsync("/api/auth/context", new { companyId = company, locationId = fabrika }, Ct);
        Assert.Equal(HttpStatusCode.OK, (await mehmet.GetAsync("/api/management/audit", Ct)).StatusCode);

        // The permission is taken away: his open session loses it immediately.
        await admin.PutAsJsonAsync($"/api/management/groups/{group}/permissions", Array.Empty<string>(), Ct);
        Assert.Equal(HttpStatusCode.Forbidden, (await mehmet.GetAsync("/api/management/audit", Ct)).StatusCode);
    }

    [Fact]
    public async Task Admins_cannot_lock_themselves_out()
    {
        var me = await (await admin.GetAsync("/api/auth/me", Ct)).JsonAsync();
        var myId = me.GetProperty("user").GetProperty("id").GetGuid();
        var groups = await (await admin.GetAsync("/api/management/groups", Ct)).JsonAsync();
        var admins = groups.EnumerateArray().Single(g => g.GetProperty("isSystem").GetBoolean()).GetProperty("id").GetGuid();

        var deactivate = await admin.PutAsJsonAsync($"/api/management/users/{myId}", new { displayName = "Yönetici", isActive = false }, Ct);
        Assert.Equal(HttpStatusCode.BadRequest, deactivate.StatusCode);
        var leave = await admin.PutAsJsonAsync($"/api/management/groups/{admins}/members", Array.Empty<object>(), Ct);
        Assert.Equal(HttpStatusCode.BadRequest, leave.StatusCode);
        var dropAll = await admin.PutAsJsonAsync($"/api/management/groups/{admins}/permissions", new[] { "system.users" }, Ct);
        Assert.Equal(HttpStatusCode.BadRequest, dropAll.StatusCode);
        var noGroups = await admin.PutAsJsonAsync($"/api/management/users/{myId}/groups", Array.Empty<object>(), Ct);
        Assert.Equal(HttpStatusCode.BadRequest, noGroups.StatusCode);
        var delete = await admin.DeleteAsync($"/api/management/groups/{admins}", Ct);
        Assert.Equal(HttpStatusCode.BadRequest, delete.StatusCode);
    }

    [Fact]
    public async Task Deactivating_a_user_or_resetting_the_password_ends_the_users_sessions()
    {
        var id = await CreateUserAsync("zeynep");
        var company = (await OrganizationAsync())[0].GetProperty("id").GetGuid();
        await admin.PutAsJsonAsync($"/api/management/users/{id}/access", new[] { new { companyId = company } }, Ct);

        var zeynep = host.Client();
        await zeynep.LoginAsync("zeynep", UserPassword);
        var sessions = await (await admin.GetAsync("/api/management/sessions", Ct)).JsonAsync();
        Assert.Contains(sessions.EnumerateArray(), s => s.GetProperty("userName").GetString() == "zeynep");

        await admin.PostAsJsonAsync($"/api/management/users/{id}/password", new { password = "Yeni2026parola", mustChangePassword = true }, Ct);
        Assert.Equal("anonymous", (await (await zeynep.GetAsync("/api/auth/me", Ct)).JsonAsync()).Status());
        Assert.Equal("passwordChange", (await zeynep.LoginAsync("zeynep", "Yeni2026parola")).Status());

        await admin.PutAsJsonAsync($"/api/management/users/{id}", new { displayName = "Zeynep", isActive = false }, Ct);
        Assert.Equal("anonymous", (await (await zeynep.GetAsync("/api/auth/me", Ct)).JsonAsync()).Status());
        Assert.Equal(AuthServiceWrongCredentials, (await zeynep.LoginAsync("zeynep", "Yeni2026parola")).Errors().Single());
    }

    const string AuthServiceWrongCredentials = Bazlama.Modules.Identity.AuthService.WrongCredentials;

    [Fact]
    public async Task Periods_must_not_overlap_and_used_records_cannot_be_deleted()
    {
        var org = await OrganizationAsync();
        var company = org[0].GetProperty("id").GetGuid();

        // Setup created 2026; a period inside it overlaps.
        var overlap = await admin.PostAsJsonAsync("/api/management/organization/periods",
            new { companyId = company, code = "2026-H2", name = "2026 2. yarı", startDate = "2026-07-01", endDate = "2026-12-31", isClosed = false }, Ct);
        Assert.Contains("çakışıyor", string.Join(" ", (await overlap.JsonAsync()).Errors()));
        await PostIdAsync("/api/management/organization/periods",
            new { companyId = company, code = "2027", name = "2027", startDate = "2027-01-01", endDate = "2027-12-31", isClosed = false });

        // The company has locations and the admin's access: it cannot be deleted.
        var delete = await admin.DeleteAsync($"/api/management/organization/companies/{company}", Ct);
        Assert.Equal(HttpStatusCode.BadRequest, delete.StatusCode);
        Assert.Equal(2, (await OrganizationAsync())[0].GetProperty("periods").GetArrayLength());
    }

    [Fact]
    public async Task Security_settings_round_trip_and_are_validated()
    {
        var settings = await (await admin.GetAsync("/api/management/settings/security", Ct)).JsonAsync();
        Assert.Equal(8, settings.GetProperty("passwordMinLength").GetInt32());

        var bad = await admin.PutAsJsonAsync("/api/management/settings/security", new { passwordMinLength = 2, lockoutMaxFailed = 5, lockoutMinutes = 15, sessionIdleMinutes = 30 }, Ct);
        Assert.Equal(HttpStatusCode.BadRequest, bad.StatusCode);
        var ok = await admin.PutAsJsonAsync("/api/management/settings/security",
            new { passwordMinLength = 12, passwordRequireMixed = true, passwordHistoryCount = 3, passwordExpireDays = 90, lockoutMaxFailed = 3, lockoutMinutes = 30, mfaRequiredForAll = false, sessionIdleMinutes = 60, singleSession = true }, Ct);
        Assert.Equal(HttpStatusCode.NoContent, ok.StatusCode);
        Assert.Equal(12, (await (await admin.GetAsync("/api/management/settings/security", Ct)).JsonAsync()).GetProperty("passwordMinLength").GetInt32());
    }

    [Fact]
    public async Task Audit_lists_data_and_security_events_newest_first()
    {
        await CreateUserAsync("ali");
        var page = await (await admin.GetAsync("/api/management/audit?q=User.create&take=10", Ct)).JsonAsync();
        Assert.Equal(2, page.GetProperty("total").GetInt32()); // admin (setup) + ali
        Assert.Equal("ali", JsonDocument.Parse(page.GetProperty("items")[0].GetProperty("data").GetString()!).RootElement.GetProperty("UserName").GetString());
        var security = await (await admin.GetAsync("/api/management/audit?category=security", Ct)).JsonAsync();
        Assert.Contains(security.GetProperty("items").EnumerateArray(), e => e.GetProperty("action").GetString() == "login.success");
    }
}
