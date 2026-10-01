using System.Globalization;
using Bazlama.Kernel;
using Bazlama.Kernel.Data;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Caching.Memory;

namespace Bazlama.Modules.Identity;

/// <summary>Sign-in and password rules; stored in sys_settings under "security.*".</summary>
public record SecuritySettings
{
    public int PasswordMinLength { get; init; } = 8;
    /// <summary>Upper case, lower case and a digit.</summary>
    public bool PasswordRequireMixed { get; init; } = true;
    /// <summary>How many previous passwords cannot be reused (0 = off).</summary>
    public int PasswordHistoryCount { get; init; } = 5;
    /// <summary>Days until a password must be changed (0 = never).</summary>
    public int PasswordExpireDays { get; init; }

    public int LockoutMaxFailed { get; init; } = 5;
    public int LockoutMinutes { get; init; } = 15;

    /// <summary>Everyone needs a second factor (otherwise only members of groups with RequireMfa).</summary>
    public bool MfaRequiredForAll { get; init; }

    /// <summary>A session without activity for this long ends.</summary>
    public int SessionIdleMinutes { get; init; } = 30;
    /// <summary>A new sign-in ends the user's other sessions.</summary>
    public bool SingleSession { get; init; }
}

public sealed class SecuritySettingsStore(KernelDbContext db, IMemoryCache cache, TimeProvider time)
{
    const string Prefix = "security.";
    const string CacheKey = "security-settings";

    public async Task<SecuritySettings> GetAsync(CancellationToken ct = default)
    {
        if (cache.TryGetValue(CacheKey, out SecuritySettings? cached)) return cached!;
        var rows = await db.SystemSettings.AsNoTracking()
            .Where(s => s.Key.StartsWith(Prefix))
            .ToDictionaryAsync(s => s.Key[Prefix.Length..], s => s.Value, ct);
        var d = new SecuritySettings();
        int I(string key, int fallback) => rows.TryGetValue(key, out var v) && int.TryParse(v, CultureInfo.InvariantCulture, out var n) ? n : fallback;
        bool B(string key, bool fallback) => rows.TryGetValue(key, out var v) && bool.TryParse(v, out var b) ? b : fallback;
        var settings = new SecuritySettings
        {
            PasswordMinLength = I(nameof(d.PasswordMinLength), d.PasswordMinLength),
            PasswordRequireMixed = B(nameof(d.PasswordRequireMixed), d.PasswordRequireMixed),
            PasswordHistoryCount = I(nameof(d.PasswordHistoryCount), d.PasswordHistoryCount),
            PasswordExpireDays = I(nameof(d.PasswordExpireDays), d.PasswordExpireDays),
            LockoutMaxFailed = I(nameof(d.LockoutMaxFailed), d.LockoutMaxFailed),
            LockoutMinutes = I(nameof(d.LockoutMinutes), d.LockoutMinutes),
            MfaRequiredForAll = B(nameof(d.MfaRequiredForAll), d.MfaRequiredForAll),
            SessionIdleMinutes = I(nameof(d.SessionIdleMinutes), d.SessionIdleMinutes),
            SingleSession = B(nameof(d.SingleSession), d.SingleSession),
        };
        cache.Set(CacheKey, settings, TimeSpan.FromMinutes(5));
        return settings;
    }

    public async Task SaveAsync(SecuritySettings s, CancellationToken ct = default)
    {
        var values = new Dictionary<string, string>
        {
            [nameof(s.PasswordMinLength)] = s.PasswordMinLength.ToString(CultureInfo.InvariantCulture),
            [nameof(s.PasswordRequireMixed)] = s.PasswordRequireMixed.ToString(),
            [nameof(s.PasswordHistoryCount)] = s.PasswordHistoryCount.ToString(CultureInfo.InvariantCulture),
            [nameof(s.PasswordExpireDays)] = s.PasswordExpireDays.ToString(CultureInfo.InvariantCulture),
            [nameof(s.LockoutMaxFailed)] = s.LockoutMaxFailed.ToString(CultureInfo.InvariantCulture),
            [nameof(s.LockoutMinutes)] = s.LockoutMinutes.ToString(CultureInfo.InvariantCulture),
            [nameof(s.MfaRequiredForAll)] = s.MfaRequiredForAll.ToString(),
            [nameof(s.SessionIdleMinutes)] = s.SessionIdleMinutes.ToString(CultureInfo.InvariantCulture),
            [nameof(s.SingleSession)] = s.SingleSession.ToString(),
        };
        var existing = await db.SystemSettings.Where(x => x.Key.StartsWith(Prefix)).ToDictionaryAsync(x => x.Key, ct);
        var now = time.GetUtcNow().UtcDateTime;
        foreach (var (key, value) in values)
        {
            if (existing.TryGetValue(Prefix + key, out var row)) { row.Value = value; row.UpdatedAt = now; }
            else db.SystemSettings.Add(new SystemSetting { Key = Prefix + key, Value = value, UpdatedAt = now });
        }
        await db.SaveChangesAsync(ct);
        cache.Remove(CacheKey);
    }

    public static IReadOnlyList<string> Validate(SecuritySettings s)
    {
        var errors = new List<string>();
        if (s.PasswordMinLength is < 6 or > 128) errors.Add("Parola uzunluğu 6 ile 128 arasında olmalı.");
        if (s.PasswordHistoryCount is < 0 or > 24) errors.Add("Parola geçmişi 0 ile 24 arasında olmalı.");
        if (s.PasswordExpireDays is < 0 or > 3650) errors.Add("Parola süresi 0 ile 3650 gün arasında olmalı.");
        if (s.LockoutMaxFailed is < 1 or > 100) errors.Add("Hatalı deneme sınırı 1 ile 100 arasında olmalı.");
        if (s.LockoutMinutes is < 1 or > 1440) errors.Add("Kilit süresi 1 ile 1440 dakika arasında olmalı.");
        if (s.SessionIdleMinutes is < 5 or > 1440) errors.Add("Oturum zaman aşımı 5 ile 1440 dakika arasında olmalı.");
        return errors;
    }
}
