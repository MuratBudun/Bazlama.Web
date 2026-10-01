using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Bazlama.Kernel.Auditing;
using Bazlama.Kernel.Data;
using Bazlama.Kernel.Identity;
using Bazlama.Kernel.Organization;
using Microsoft.AspNetCore.DataProtection;
using Microsoft.AspNetCore.Identity;
using Microsoft.EntityFrameworkCore;

namespace Bazlama.Modules.Identity;

public sealed record LoginResult(UserSession? Session, string? Error);
public sealed record MfaSetup(string Secret, string Uri, string QrSvg);
public sealed record SetupRequest(string UserName, string DisplayName, string Password, string CompanyCode, string CompanyName, string LocationCode, string LocationName);

/// <summary>
/// The sign-in steps. A session moves: password accepted → second factor (verify, or set up
/// when required) → new password (when it must change) → Active.
/// </summary>
public sealed class AuthService(
    KernelDbContext db,
    PasswordService passwords,
    SecuritySettingsStore settingsStore,
    SessionStore sessions,
    OrgContextService orgContext,
    IDataProtectionProvider protection,
    TimeProvider time)
{
    public const string WrongCredentials = "Kullanıcı adı veya parola hatalı.";
    const string Issuer = "Bazlama";

    readonly IDataProtector totpProtector = protection.CreateProtector("Bazlama.Totp.v1");

    DateTime Now => time.GetUtcNow().UtcDateTime;

    public async Task<bool> SetupRequiredAsync(CancellationToken ct = default) => !await db.Users.AnyAsync(ct);

    // ── Password ───────────────────────────────────────────────────────────

    public async Task<LoginResult> LoginAsync(string userName, string password, string channel, string? ip, string? userAgent, CancellationToken ct = default)
    {
        var settings = await settingsStore.GetAsync(ct);
        var normalized = User.Normalize(userName);
        var user = await db.Users.FirstOrDefaultAsync(u => u.NormalizedUserName == normalized, ct);

        if (user is null || !user.IsActive)
        {
            PasswordService.Verify(null, password); // same cost as a real check
            Audit("login.failed", user, ip, new { userName, reason = user is null ? "unknown-user" : "inactive" });
            await db.SaveChangesAsync(ct);
            return new(null, WrongCredentials);
        }
        if (user.LockoutEndsAt is { } until && until > Now)
        {
            Audit("login.locked", user, ip, null);
            await db.SaveChangesAsync(ct);
            return new(null, LockedMessage(until));
        }

        var result = PasswordService.Verify(user.PasswordHash, password);
        if (result == PasswordVerificationResult.Failed)
        {
            var locked = RegisterFailure(user, settings, ip, "password");
            await db.SaveChangesAsync(ct);
            return new(null, locked ? LockedMessage(user.LockoutEndsAt!.Value) : WrongCredentials);
        }
        if (result == PasswordVerificationResult.SuccessRehashNeeded) user.PasswordHash = PasswordService.Hash(password);
        user.FailedLoginCount = 0;
        user.LockoutEndsAt = null;

        var session = new UserSession
        {
            UserId = user.Id,
            Channel = channel,
            CreatedAt = Now,
            LastSeenAt = Now,
            IpAddress = ip,
            UserAgent = userAgent is { Length: > 500 } ? userAgent[..500] : userAgent,
        };
        db.UserSessions.Add(session);
        await AdvanceAsync(session, user, mfaDone: false, settings, ct);
        Audit("login.password", user, ip, null, session.Id);
        await db.SaveChangesAsync(ct);
        return new(session, null);
    }

    /// <summary>Counts a failed attempt; true when it locked the account.</summary>
    bool RegisterFailure(User user, SecuritySettings settings, string? ip, string what)
    {
        user.FailedLoginCount++;
        Audit("login.failed", user, ip, new { reason = what, user.FailedLoginCount });
        if (user.FailedLoginCount < settings.LockoutMaxFailed) return false;
        user.FailedLoginCount = 0;
        user.LockoutEndsAt = Now.AddMinutes(settings.LockoutMinutes);
        Audit("login.lockout", user, ip, new { until = user.LockoutEndsAt });
        return true;
    }

    static string LockedMessage(DateTime untilUtc) =>
        $"Hesap çok sayıda hatalı deneme nedeniyle kilitlendi. {untilUtc.ToLocalTime():HH:mm} sonra tekrar deneyin.";

    /// <summary>Moves a session to its next step after one is completed.</summary>
    async Task AdvanceAsync(UserSession session, User user, bool mfaDone, SecuritySettings settings, CancellationToken ct)
    {
        if (!mfaDone && user.TotpEnabled) { session.Status = SessionStatus.PendingMfa; return; }
        if (!mfaDone && await MfaRequiredAsync(user, settings, ct)) { session.Status = SessionStatus.PendingMfaEnrollment; return; }
        if (user.MustChangePassword || passwords.IsExpired(user, settings)) { session.Status = SessionStatus.PendingPasswordChange; return; }

        session.Status = SessionStatus.Active;
        user.LastLoginAt = Now;
        if (settings.SingleSession) await sessions.EndAllOfUserAsync(user.Id, "replaced", except: session.Id, ct);
        var selection = orgContext.Default(await orgContext.OptionsAsync(user.Id, ct), user);
        if (selection is not null) Apply(session, user, selection);
        Audit("login.success", user, session.IpAddress, null, session.Id);
    }

    public async Task<bool> MfaRequiredAsync(User user, SecuritySettings settings, CancellationToken ct) =>
        settings.MfaRequiredForAll
        || await (from m in db.GroupMembers join g in db.Groups on m.GroupId equals g.Id where m.UserId == user.Id && g.RequireMfa select g.Id).AnyAsync(ct);

    /// <summary>Changes the password: the pending step of a sign-in (no current password asked) or a signed-in user's own change.</summary>
    public async Task<IReadOnlyList<string>> ChangePasswordAsync(Guid sessionId, string? currentPassword, string newPassword, CancellationToken ct = default)
    {
        var (session, user) = await LoadAsync(sessionId, ct);
        if (session.Status == SessionStatus.Active)
        {
            if (currentPassword is null || PasswordService.Verify(user.PasswordHash, currentPassword) == PasswordVerificationResult.Failed)
                return ["Mevcut parola hatalı."];
        }
        else if (session.Status != SessionStatus.PendingPasswordChange)
            return ["Bu adımda parola değiştirilemez."];

        var settings = await settingsStore.GetAsync(ct);
        var errors = await passwords.ValidateAsync(user, newPassword, settings, ct);
        if (errors.Count > 0) return errors;

        passwords.SetPassword(user, newPassword, mustChange: false);
        Audit("password.change", user, session.IpAddress, null, session.Id);
        if (session.Status == SessionStatus.PendingPasswordChange)
            await AdvanceAsync(session, user, mfaDone: true, settings, ct);
        else
            await sessions.EndAllOfUserAsync(user.Id, "password-changed", except: session.Id, ct);
        await db.SaveChangesAsync(ct);
        sessions.Invalidate(session.Id);
        return [];
    }

    // ── Second factor ──────────────────────────────────────────────────────

    /// <summary>A new secret (not active until a code from it is confirmed).</summary>
    public async Task<MfaSetup?> BeginMfaSetupAsync(Guid sessionId, CancellationToken ct = default)
    {
        var (session, user) = await LoadAsync(sessionId, ct);
        var allowed = session.Status == SessionStatus.PendingMfaEnrollment || (session.Status == SessionStatus.Active && !user.TotpEnabled);
        if (!allowed) return null;
        var secret = Totp.NewSecret();
        user.TotpSecret = totpProtector.Protect(Convert.ToBase64String(secret));
        user.TotpLastStep = null;
        await db.SaveChangesAsync(ct);
        var uri = Totp.OtpAuthUri(secret, Issuer, user.UserName);
        return new MfaSetup(Base32.Encode(secret), uri, Totp.QrSvg(uri));
    }

    /// <summary>Confirms the authenticator with a code; returns new recovery codes, or an error.</summary>
    public async Task<(IReadOnlyList<string>? RecoveryCodes, string? Error)> CompleteMfaSetupAsync(Guid sessionId, string code, CancellationToken ct = default)
    {
        var (session, user) = await LoadAsync(sessionId, ct);
        var allowed = session.Status == SessionStatus.PendingMfaEnrollment || (session.Status == SessionStatus.Active && !user.TotpEnabled);
        if (!allowed || user.TotpSecret is null) return (null, "Önce doğrulama uygulamasını kurun.");
        var step = Totp.Verify(Secret(user), code, time.GetUtcNow(), user.TotpLastStep);
        if (step is null) return (null, "Kod doğrulanamadı. Uygulamadaki güncel kodu girin.");

        user.TotpEnabled = true;
        user.TotpLastStep = step;
        var codes = await NewRecoveryCodesAsync(user, ct);
        Audit("mfa.enable", user, session.IpAddress, null, session.Id);
        if (session.Status == SessionStatus.PendingMfaEnrollment)
            await AdvanceAsync(session, user, mfaDone: true, await settingsStore.GetAsync(ct), ct);
        await db.SaveChangesAsync(ct);
        sessions.Invalidate(session.Id);
        return (codes, null);
    }

    /// <summary>The second step of a sign-in: a TOTP code or a recovery code.</summary>
    public async Task<string?> VerifyMfaAsync(Guid sessionId, string code, CancellationToken ct = default)
    {
        var (session, user) = await LoadAsync(sessionId, ct);
        if (session.Status != SessionStatus.PendingMfa) return "Bu adımda doğrulama kodu beklenmiyor.";
        var settings = await settingsStore.GetAsync(ct);
        if (user.LockoutEndsAt is { } until && until > Now) return LockedMessage(until);

        var ok = false;
        var compact = code.Replace(" ", "").Replace("-", "");
        if (compact.Length == 6 && compact.All(char.IsAsciiDigit))
        {
            if (Totp.Verify(Secret(user), compact, time.GetUtcNow(), user.TotpLastStep) is { } step)
            {
                user.TotpLastStep = step;
                ok = true;
            }
        }
        else
        {
            var hash = HashRecoveryCode(compact);
            var recovery = await db.UserRecoveryCodes.FirstOrDefaultAsync(r => r.UserId == user.Id && r.CodeHash == hash && r.UsedAt == null, ct);
            if (recovery is not null)
            {
                recovery.UsedAt = Now;
                Audit("mfa.recovery-code", user, session.IpAddress, null, session.Id);
                ok = true;
            }
        }

        if (!ok)
        {
            if (RegisterFailure(user, settings, session.IpAddress, "mfa"))
            {
                session.Status = SessionStatus.Ended;
                session.EndedAt = Now;
                session.EndReason = "lockout";
                await db.SaveChangesAsync(ct);
                sessions.Invalidate(session.Id);
                return LockedMessage(user.LockoutEndsAt!.Value);
            }
            await db.SaveChangesAsync(ct);
            return "Kod doğrulanamadı.";
        }
        user.FailedLoginCount = 0;
        await AdvanceAsync(session, user, mfaDone: true, settings, ct);
        await db.SaveChangesAsync(ct);
        sessions.Invalidate(session.Id);
        return null;
    }

    byte[] Secret(User user) => Convert.FromBase64String(totpProtector.Unprotect(user.TotpSecret!));

    async Task<IReadOnlyList<string>> NewRecoveryCodesAsync(User user, CancellationToken ct)
    {
        await db.UserRecoveryCodes.Where(r => r.UserId == user.Id).ExecuteDeleteAsync(ct);
        const string alphabet = "abcdefghjkmnpqrstuvwxyz23456789";
        var codes = Enumerable.Range(0, 10)
            .Select(_ => RandomNumberGenerator.GetString(alphabet, 10))
            .Select(c => $"{c[..5]}-{c[5..]}")
            .ToList();
        db.UserRecoveryCodes.AddRange(codes.Select(c => new UserRecoveryCode { UserId = user.Id, CodeHash = HashRecoveryCode(c.Replace("-", "")) }));
        return codes;
    }

    /// <summary>Recovery codes are random (50 bits), so a plain SHA-256 is enough.</summary>
    static string HashRecoveryCode(string code) =>
        Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(code.ToLowerInvariant())));

    // ── Context, sign-out, first setup ─────────────────────────────────────

    public async Task<string?> SelectContextAsync(Guid sessionId, ContextSelection selection, CancellationToken ct = default)
    {
        var (session, user) = await LoadAsync(sessionId, ct);
        if (session.Status != SessionStatus.Active) return "Oturum etkin değil.";
        var error = OrgContextService.Validate(await orgContext.OptionsAsync(user.Id, ct), selection);
        if (error is not null) return error;
        Apply(session, user, selection);
        await db.SaveChangesAsync(ct);
        sessions.Invalidate(session.Id);
        return null;
    }

    static void Apply(UserSession session, User user, ContextSelection s)
    {
        (session.CompanyId, session.LocationId, session.PlantId, session.PeriodId) = (s.CompanyId, s.LocationId, s.PlantId, s.PeriodId);
        (user.LastCompanyId, user.LastLocationId, user.LastPlantId, user.LastPeriodId) = (s.CompanyId, s.LocationId, s.PlantId, s.PeriodId);
    }

    public async Task LogoutAsync(Guid sessionId, CancellationToken ct = default)
    {
        await sessions.EndAsync(sessionId, "logout", ct);
        var userId = await db.UserSessions.Where(s => s.Id == sessionId).Select(s => (Guid?)s.UserId).FirstOrDefaultAsync(ct);
        db.AuditEvents.Add(Event("logout", userId, null, null, null, sessionId));
        await db.SaveChangesAsync(ct);
    }

    /// <summary>
    /// First run (no users yet): the administrator, the Administrators group (all permissions),
    /// the first company and location, and a period for the current year.
    /// </summary>
    public async Task<IReadOnlyList<string>> SetupAsync(SetupRequest r, CancellationToken ct = default)
    {
        if (await db.Users.AnyAsync(ct)) return ["Kurulum zaten yapılmış."];
        var errors = new List<string>();
        if (string.IsNullOrWhiteSpace(r.UserName)) errors.Add("Kullanıcı adı gerekli.");
        if (string.IsNullOrWhiteSpace(r.DisplayName)) errors.Add("Ad soyad gerekli.");
        if (string.IsNullOrWhiteSpace(r.CompanyCode) || string.IsNullOrWhiteSpace(r.CompanyName)) errors.Add("Firma kodu ve adı gerekli.");
        if (string.IsNullOrWhiteSpace(r.LocationCode) || string.IsNullOrWhiteSpace(r.LocationName)) errors.Add("Lokasyon kodu ve adı gerekli.");
        var user = new User
        {
            UserName = r.UserName.Trim(),
            NormalizedUserName = User.Normalize(r.UserName),
            DisplayName = r.DisplayName.Trim(),
            CreatedAt = Now,
        };
        errors.AddRange(await passwords.ValidateAsync(user, r.Password, await settingsStore.GetAsync(ct), ct));
        if (errors.Count > 0) return errors;

        var company = new Company { Code = r.CompanyCode.Trim(), Name = r.CompanyName.Trim() };
        var location = new Location { CompanyId = company.Id, Code = r.LocationCode.Trim(), Name = r.LocationName.Trim() };
        var year = time.GetLocalNow().Year;
        var period = new Period { CompanyId = company.Id, Code = $"{year}", Name = $"{year}", StartDate = new DateOnly(year, 1, 1), EndDate = new DateOnly(year, 12, 31) };
        var admins = new Group { Code = "ADMINISTRATORS", Name = "Yöneticiler", Description = "Tüm yetkiler", IsSystem = true };
        passwords.SetPassword(user, r.Password, mustChange: false);

        db.AddRange(company, location, period, admins, user);
        db.Add(new GroupPermission { GroupId = admins.Id, Permission = Permissions.All });
        db.Add(new GroupMember { GroupId = admins.Id, UserId = user.Id });
        db.Add(new UserOrgAccess { UserId = user.Id, CompanyId = company.Id });
        Audit("setup", user, null, null);
        await db.SaveChangesAsync(ct);
        return [];
    }

    // ── Helpers ────────────────────────────────────────────────────────────

    async Task<(UserSession Session, User User)> LoadAsync(Guid sessionId, CancellationToken ct)
    {
        var session = await db.UserSessions.FirstAsync(s => s.Id == sessionId, ct);
        var user = await db.Users.FirstAsync(u => u.Id == session.UserId, ct);
        return (session, user);
    }

    void Audit(string action, User? user, string? ip, object? data, Guid? sessionId = null) =>
        db.AuditEvents.Add(Event(action, user?.Id, user?.UserName, ip, data, sessionId));

    AuditEvent Event(string action, Guid? userId, string? userName, string? ip, object? data, Guid? sessionId) => new()
    {
        At = Now,
        Category = "security",
        Action = action,
        UserId = userId,
        UserName = userName,
        SessionId = sessionId,
        IpAddress = ip,
        EntityType = userId is null ? null : nameof(User),
        EntityId = userId?.ToString(),
        Data = data is null ? null : JsonSerializer.Serialize(data),
    };
}
