using Bazlama.Kernel.Data;
using Bazlama.Kernel.Identity;
using Microsoft.AspNetCore.Identity;
using Microsoft.EntityFrameworkCore;

namespace Bazlama.Modules.Identity;

/// <summary>Hashing (ASP.NET Core Identity's PBKDF2 hasher), policy checks and password changes.</summary>
public sealed class PasswordService(KernelDbContext db, TimeProvider time)
{
    static readonly PasswordHasher<User> Hasher = new();

    /// <summary>Hashed for unknown users too, so a missing account takes as long as a wrong password.</summary>
    static readonly string DummyHash = Hasher.HashPassword(null!, "dummy-password-for-timing");

    public static string Hash(string password) => Hasher.HashPassword(null!, password);

    public static PasswordVerificationResult Verify(string? hash, string password)
    {
        var result = Hasher.VerifyHashedPassword(null!, hash ?? DummyHash, password);
        return hash is null ? PasswordVerificationResult.Failed : result;
    }

    /// <summary>Policy errors for a new password (empty = acceptable).</summary>
    public async Task<IReadOnlyList<string>> ValidateAsync(User user, string password, SecuritySettings policy, CancellationToken ct = default)
    {
        var errors = new List<string>();
        if (password.Length < policy.PasswordMinLength)
            errors.Add($"Parola en az {policy.PasswordMinLength} karakter olmalı.");
        if (policy.PasswordRequireMixed && !(password.Any(char.IsUpper) && password.Any(char.IsLower) && password.Any(char.IsDigit)))
            errors.Add("Parola büyük harf, küçük harf ve rakam içermeli.");
        if (password.Contains(user.UserName, StringComparison.OrdinalIgnoreCase))
            errors.Add("Parola kullanıcı adını içermemeli.");
        if (policy.PasswordHistoryCount > 0)
        {
            var recent = await db.UserPasswordHistory.AsNoTracking()
                .Where(h => h.UserId == user.Id)
                .OrderByDescending(h => h.CreatedAt)
                .Take(policy.PasswordHistoryCount)
                .Select(h => h.PasswordHash)
                .ToListAsync(ct);
            if (user.PasswordHash is not null) recent.Add(user.PasswordHash);
            if (recent.Any(h => Hasher.VerifyHashedPassword(user, h, password) != PasswordVerificationResult.Failed))
                errors.Add($"Parola son {policy.PasswordHistoryCount} paroladan biriyle aynı olmamalı.");
        }
        return errors;
    }

    /// <summary>Sets the password (the caller saves). The old hash goes to the history.</summary>
    public void SetPassword(User user, string password, bool mustChange)
    {
        var now = time.GetUtcNow().UtcDateTime;
        if (user.PasswordHash is not null)
            db.UserPasswordHistory.Add(new UserPasswordHistory { UserId = user.Id, PasswordHash = user.PasswordHash, CreatedAt = now });
        user.PasswordHash = Hash(password);
        user.PasswordChangedAt = now;
        user.MustChangePassword = mustChange;
    }

    public bool IsExpired(User user, SecuritySettings policy) =>
        policy.PasswordExpireDays > 0
        && user.PasswordChangedAt is { } changed
        && changed.AddDays(policy.PasswordExpireDays) < time.GetUtcNow().UtcDateTime;
}
