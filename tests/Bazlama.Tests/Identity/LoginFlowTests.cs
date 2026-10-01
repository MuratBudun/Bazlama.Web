using System.Net;
using System.Net.Http.Json;
using Bazlama.Kernel.Identity;
using Bazlama.Modules.Identity;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using static Bazlama.Tests.TestHost;

namespace Bazlama.Tests.Identity;

public sealed class LoginFlowTests : IAsyncLifetime
{
    readonly TestHost host = new();

    public async ValueTask InitializeAsync() => await host.SetupAsync();
    public ValueTask DisposeAsync() => host.DisposeAsync();

    [Fact]
    public async Task Setup_creates_an_admin_who_signs_in_with_all_permissions_and_a_default_context()
    {
        var client = host.Client();
        var me = await client.LoginAsync(AdminUser, AdminPassword);

        Assert.Equal("active", me.Status());
        Assert.Contains("*", me.GetProperty("permissions").EnumerateArray().Select(p => p.GetString()));
        // One company with one location: chosen without asking, with the current year's period.
        Assert.False(me.GetProperty("contextRequired").GetBoolean());
        Assert.Equal("Merkez", me.GetProperty("context").GetProperty("location").GetProperty("name").GetString());
        Assert.Equal("2026", me.GetProperty("context").GetProperty("period").GetProperty("code").GetString());
    }

    [Fact]
    public async Task Setup_runs_only_once()
    {
        var res = await host.Client().PostAsJsonAsync("/api/auth/setup",
            new SetupRequest("other", "Other", "Other12345", "C2", "F2", "L2", "M2"), Ct);
        Assert.Equal(HttpStatusCode.BadRequest, res.StatusCode);
    }

    [Fact]
    public async Task Me_is_anonymous_before_sign_in_and_protected_endpoints_answer_401()
    {
        var client = host.Client();
        var me = await (await client.GetAsync("/api/auth/me", Ct)).JsonAsync();
        Assert.Equal("anonymous", me.Status());
        Assert.False(me.GetProperty("setupRequired").GetBoolean());
        Assert.Equal(HttpStatusCode.Unauthorized, (await client.GetAsync("/api/auth/context/options", Ct)).StatusCode);
    }

    [Fact]
    public async Task State_changing_calls_without_the_request_header_are_rejected()
    {
        var bare = host.Factory.CreateClient();
        var res = await bare.PostAsJsonAsync("/api/auth/login", new { userName = AdminUser, password = AdminPassword }, Ct);
        Assert.Equal(HttpStatusCode.BadRequest, res.StatusCode);
    }

    [Fact]
    public async Task Wrong_passwords_lock_the_account_for_the_configured_time()
    {
        var client = host.Client();
        for (var i = 0; i < 4; i++)
            Assert.Equal(AuthService.WrongCredentials, (await client.LoginAsync(AdminUser, "wrong")).Errors().Single());

        var fifth = await client.LoginAsync(AdminUser, "wrong");
        Assert.StartsWith("Hesap çok sayıda hatalı deneme", fifth.Errors().Single());
        // Locked: even the right password is refused…
        Assert.StartsWith("Hesap çok sayıda hatalı deneme", (await client.LoginAsync(AdminUser, AdminPassword)).Errors().Single());
        // …until the lockout ends.
        host.Clock.Advance(TimeSpan.FromMinutes(16));
        Assert.Equal("active", (await client.LoginAsync(AdminUser, AdminPassword)).Status());

        var actions = await host.WithDbAsync(db => db.AuditEvents.Select(e => e.Action).ToListAsync(Ct));
        Assert.Contains("login.lockout", actions);
    }

    [Fact]
    public async Task Unknown_users_get_the_same_answer_as_wrong_passwords()
    {
        var me = await host.Client().LoginAsync("nobody", "whatever");
        Assert.Equal(AuthService.WrongCredentials, me.Errors().Single());
    }

    [Fact]
    public async Task Mfa_enrollment_when_required_then_codes_and_recovery_codes_work_once()
    {
        await host.WithServicesAsync(async sp =>
        {
            var store = sp.GetRequiredService<SecuritySettingsStore>();
            await store.SaveAsync(await store.GetAsync(Ct) with { MfaRequiredForAll = true }, Ct);
        });

        // 1. Password accepted; the authenticator must be set up before anything else.
        var client = host.Client();
        Assert.Equal("mfaEnrollment", (await client.LoginAsync(AdminUser, AdminPassword)).Status());
        // Signed in halfway: known, but not allowed anywhere yet.
        Assert.Equal(HttpStatusCode.Forbidden, (await client.GetAsync("/api/auth/context/options", Ct)).StatusCode);

        var setup = await (await client.PostAsync("/api/auth/mfa/setup", null, Ct)).JsonAsync();
        var secret = Base32.Decode(setup.GetProperty("secret").GetString()!);
        Assert.StartsWith("otpauth://totp/Bazlama:admin?", setup.GetProperty("uri").GetString());
        Assert.StartsWith("<svg", setup.GetProperty("qrSvg").GetString());

        var bad = await (await client.PostAsJsonAsync("/api/auth/mfa/confirm", new { code = "000000" }, Ct)).JsonAsync();
        Assert.Single(bad.Errors());
        var confirmed = await (await client.PostAsJsonAsync("/api/auth/mfa/confirm", new { code = CodeNow(secret) }, Ct)).JsonAsync();
        Assert.Equal("active", confirmed.GetProperty("me").Status());
        var recovery = confirmed.GetProperty("recoveryCodes").EnumerateArray().Select(c => c.GetString()!).ToList();
        Assert.Equal(10, recovery.Count);

        // 2. Next sign-in asks for a code; the code just used is not accepted again.
        var second = host.Client();
        Assert.Equal("mfa", (await second.LoginAsync(AdminUser, AdminPassword)).Status());
        var replay = await (await second.PostAsJsonAsync("/api/auth/mfa/verify", new { code = CodeNow(secret) }, Ct)).JsonAsync();
        Assert.Equal("Kod doğrulanamadı.", replay.Errors().Single());
        host.Clock.Advance(TimeSpan.FromSeconds(30));
        Assert.Equal("active", (await (await second.PostAsJsonAsync("/api/auth/mfa/verify", new { code = CodeNow(secret) }, Ct)).JsonAsync()).Status());

        // 3. A recovery code instead of the app works, once.
        var third = host.Client();
        await third.LoginAsync(AdminUser, AdminPassword);
        Assert.Equal("active", (await (await third.PostAsJsonAsync("/api/auth/mfa/verify", new { code = recovery[0] }, Ct)).JsonAsync()).Status());
        var fourth = host.Client();
        await fourth.LoginAsync(AdminUser, AdminPassword);
        Assert.Single((await (await fourth.PostAsJsonAsync("/api/auth/mfa/verify", new { code = recovery[0] }, Ct)).JsonAsync()).Errors());
    }

    string CodeNow(byte[] secret) => Totp.Code(secret, Totp.StepAt(host.Clock.Now));

    [Fact]
    public async Task A_required_password_change_comes_before_the_session_is_active_and_follows_the_policy()
    {
        await host.WithDbAsync(db => db.Users.ExecuteUpdateAsync(u => u.SetProperty(x => x.MustChangePassword, true), Ct));

        var client = host.Client();
        Assert.Equal("passwordChange", (await client.LoginAsync(AdminUser, AdminPassword)).Status());

        var weak = await (await client.PostAsJsonAsync("/api/auth/password", new { newPassword = "abc" }, Ct)).JsonAsync();
        Assert.Contains("Parola en az 8 karakter olmalı.", weak.Errors());
        var reused = await (await client.PostAsJsonAsync("/api/auth/password", new { newPassword = AdminPassword }, Ct)).JsonAsync();
        Assert.Contains(reused.Errors(), e => e.StartsWith("Parola son"));

        var ok = await (await client.PostAsJsonAsync("/api/auth/password", new { newPassword = "Yeni12345x" }, Ct)).JsonAsync();
        Assert.Equal("active", ok.Status());
        Assert.Equal("active", (await host.Client().LoginAsync(AdminUser, "Yeni12345x")).Status());
    }

    [Fact]
    public async Task Idle_sessions_expire_and_ended_sessions_are_anonymous()
    {
        var client = host.Client();
        await client.LoginAsync(AdminUser, AdminPassword);
        host.Clock.Advance(TimeSpan.FromMinutes(20));
        Assert.Equal("active", (await (await client.GetAsync("/api/auth/me", Ct)).JsonAsync()).Status());
        host.Clock.Advance(TimeSpan.FromMinutes(31));
        Assert.Equal("anonymous", (await (await client.GetAsync("/api/auth/me", Ct)).JsonAsync()).Status());

        var other = host.Client();
        await other.LoginAsync(AdminUser, AdminPassword);
        var sid = await host.WithDbAsync(db => db.UserSessions.Where(s => s.Status == SessionStatus.Active).Select(s => s.Id).SingleAsync(Ct));
        await host.WithServicesAsync(sp => sp.GetRequiredService<SessionStore>().EndAsync(sid, "revoked", Ct));
        Assert.Equal("anonymous", (await (await other.GetAsync("/api/auth/me", Ct)).JsonAsync()).Status());
    }

    [Fact]
    public async Task Logout_ends_the_session()
    {
        var client = host.Client();
        await client.LoginAsync(AdminUser, AdminPassword);
        Assert.Equal(HttpStatusCode.NoContent, (await client.PostAsync("/api/auth/logout", null, Ct)).StatusCode);
        Assert.Equal("anonymous", (await (await client.GetAsync("/api/auth/me", Ct)).JsonAsync()).Status());
    }

    [Fact]
    public async Task Data_changes_are_audited_without_secrets()
    {
        var created = await host.WithDbAsync(db => db.AuditEvents.Where(e => e.Action == "User.create").Select(e => e.Data!).SingleAsync(Ct));
        Assert.Contains("\"PasswordHash\":\"***\"", created);
        Assert.Contains("\"UserName\":\"admin\"", created);
    }
}
