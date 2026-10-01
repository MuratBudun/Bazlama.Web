using Bazlama.Kernel.Data;
using Bazlama.Kernel.Identity;
using Bazlama.Modules.Identity;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Routing;
using Microsoft.EntityFrameworkCore;
using static Bazlama.Modules.Management.Http;

namespace Bazlama.Modules.Management;

public sealed record UserRow(Guid Id, string UserName, string DisplayName, string? Email, bool IsActive, bool MfaEnabled,
    bool MustChangePassword, DateTime? LockoutEndsAt, DateTime? LastLoginAt, DateTime CreatedAt, IReadOnlyList<string> Groups);
public sealed record UserCreate(string UserName, string DisplayName, string? Email, string Password, bool MustChangePassword);
public sealed record UserUpdate(string DisplayName, string? Email, bool IsActive);
public sealed record PasswordReset(string Password, bool MustChangePassword);
public sealed record AccessItem(Guid CompanyId, Guid? LocationId, Guid? PlantId);
public sealed record MembershipItem(Guid GroupId, Guid? LocationId);
public sealed record UserDetail(UserRow User, IReadOnlyList<MembershipItem> Groups, IReadOnlyList<AccessItem> Access);

static class UserEndpoints
{
    public static void MapUserEndpoints(this RouteGroupBuilder api)
    {
        var users = api.MapGroup("/users").RequirePermission(Permissions.Users);

        users.MapGet("/", async (KernelDbContext db, TimeProvider time, CancellationToken ct) =>
        {
            var groups = await (from m in db.GroupMembers join g in db.Groups on m.GroupId equals g.Id select new { m.UserId, g.Name })
                .ToListAsync(ct);
            var byUser = groups.GroupBy(x => x.UserId).ToDictionary(x => x.Key, x => (IReadOnlyList<string>)[.. x.Select(y => y.Name).Distinct().Order()]);
            var list = await db.Users.AsNoTracking().OrderBy(u => u.UserName).ToListAsync(ct);
            return list.Select(u => ToRow(u, byUser.GetValueOrDefault(u.Id) ?? [], time));
        });

        users.MapGet("/{id:guid}", async (Guid id, KernelDbContext db, TimeProvider time, CancellationToken ct) =>
        {
            var u = await db.Users.AsNoTracking().FirstOrDefaultAsync(x => x.Id == id, ct);
            if (u is null) return Results.NotFound();
            var memberships = await db.GroupMembers.AsNoTracking().Where(m => m.UserId == id).Select(m => new MembershipItem(m.GroupId, m.LocationId)).ToListAsync(ct);
            var names = await db.Groups.Where(g => memberships.Select(m => m.GroupId).Contains(g.Id)).Select(g => g.Name).ToListAsync(ct);
            var access = await db.UserOrgAccess.AsNoTracking().Where(a => a.UserId == id).Select(a => new AccessItem(a.CompanyId, a.LocationId, a.PlantId)).ToListAsync(ct);
            return Results.Ok(new UserDetail(ToRow(u, [.. names.Distinct().Order()], time), memberships, access));
        });

        users.MapPost("/", async (UserCreate r, KernelDbContext db, PasswordService passwords, SecuritySettingsStore settings, TimeProvider time, CancellationToken ct) =>
        {
            var errors = new List<string>();
            if (Blank(r.UserName)) errors.Add("Kullanıcı adı gerekli.");
            else if (await db.Users.AnyAsync(u => u.NormalizedUserName == User.Normalize(r.UserName), ct)) errors.Add("Bu kullanıcı adı kullanılıyor.");
            if (Blank(r.DisplayName)) errors.Add("Ad soyad gerekli.");
            if (errors.Count > 0) return Errors(errors);

            var user = new User
            {
                UserName = r.UserName.Trim(),
                NormalizedUserName = User.Normalize(r.UserName),
                DisplayName = r.DisplayName.Trim(),
                Email = Blank(r.Email) ? null : r.Email!.Trim(),
                CreatedAt = time.GetUtcNow().UtcDateTime,
            };
            var policy = await passwords.ValidateAsync(user, r.Password ?? "", await settings.GetAsync(ct), ct);
            if (policy.Count > 0) return Errors(policy);
            passwords.SetPassword(user, r.Password!, r.MustChangePassword);
            db.Users.Add(user);
            await db.SaveChangesAsync(ct);
            return Results.Ok(new { user.Id });
        });

        users.MapPut("/{id:guid}", async (Guid id, UserUpdate r, KernelDbContext db, CurrentSession current, SessionStore sessions, CancellationToken ct) =>
        {
            var user = await db.Users.FirstOrDefaultAsync(u => u.Id == id, ct);
            if (user is null) return Results.NotFound();
            if (Blank(r.DisplayName)) return Errors("Ad soyad gerekli.");
            if (!r.IsActive && id == current.Snapshot!.UserId) return Errors("Kendi hesabınızı pasif yapamazsınız.");
            var deactivated = user.IsActive && !r.IsActive;
            user.DisplayName = r.DisplayName.Trim();
            user.Email = Blank(r.Email) ? null : r.Email!.Trim();
            user.IsActive = r.IsActive;
            await db.SaveChangesAsync(ct);
            if (deactivated) await sessions.EndAllOfUserAsync(id, "deactivated", ct: ct);
            return Results.NoContent();
        });

        users.MapPost("/{id:guid}/password", async (Guid id, PasswordReset r, KernelDbContext db, PasswordService passwords, SecuritySettingsStore settings, SessionStore sessions, CancellationToken ct) =>
        {
            var user = await db.Users.FirstOrDefaultAsync(u => u.Id == id, ct);
            if (user is null) return Results.NotFound();
            var policy = await passwords.ValidateAsync(user, r.Password ?? "", await settings.GetAsync(ct), ct);
            if (policy.Count > 0) return Errors(policy);
            passwords.SetPassword(user, r.Password!, r.MustChangePassword);
            user.FailedLoginCount = 0;
            user.LockoutEndsAt = null;
            await db.SaveChangesAsync(ct);
            await sessions.EndAllOfUserAsync(id, "password-reset", ct: ct);
            return Results.NoContent();
        });

        users.MapPost("/{id:guid}/unlock", async (Guid id, KernelDbContext db, CancellationToken ct) =>
        {
            var user = await db.Users.FirstOrDefaultAsync(u => u.Id == id, ct);
            if (user is null) return Results.NotFound();
            user.LockoutEndsAt = null;
            user.FailedLoginCount = 0;
            await db.SaveChangesAsync(ct);
            return Results.NoContent();
        });

        users.MapPost("/{id:guid}/reset-mfa", async (Guid id, KernelDbContext db, SessionStore sessions, CancellationToken ct) =>
        {
            var user = await db.Users.FirstOrDefaultAsync(u => u.Id == id, ct);
            if (user is null) return Results.NotFound();
            user.TotpEnabled = false;
            user.TotpSecret = null;
            user.TotpLastStep = null;
            await db.UserRecoveryCodes.Where(r => r.UserId == id).ExecuteDeleteAsync(ct);
            await db.SaveChangesAsync(ct);
            await sessions.EndAllOfUserAsync(id, "mfa-reset", ct: ct);
            return Results.NoContent();
        });

        users.MapPut("/{id:guid}/groups", async (Guid id, List<MembershipItem> items, KernelDbContext db, CurrentSession current, CancellationToken ct) =>
        {
            if (!await db.Users.AnyAsync(u => u.Id == id, ct)) return Results.NotFound();
            if (id == current.Snapshot!.UserId && !await KeepsAdministratorAsync(db, id, items, ct))
                return Errors("Kendinizi Yöneticiler grubundan çıkaramazsınız.");
            var existing = await db.GroupMembers.Where(m => m.UserId == id).ToListAsync(ct);
            db.GroupMembers.RemoveRange(existing.Where(m => !items.Any(i => i.GroupId == m.GroupId && i.LocationId == m.LocationId)));
            foreach (var i in items.DistinctBy(i => (i.GroupId, i.LocationId)))
                if (!existing.Any(m => m.GroupId == i.GroupId && m.LocationId == i.LocationId))
                    db.GroupMembers.Add(new GroupMember { UserId = id, GroupId = i.GroupId, LocationId = i.LocationId });
            var result = await SaveOrInUseAsync(db, "Grup veya lokasyon bulunamadı.", ct);
            SessionStore.PermissionsChanged();
            return result;
        });

        users.MapPut("/{id:guid}/access", async (Guid id, List<AccessItem> items, KernelDbContext db, CancellationToken ct) =>
        {
            if (!await db.Users.AnyAsync(u => u.Id == id, ct)) return Results.NotFound();
            foreach (var i in items)
            {
                if (i.PlantId is not null && i.LocationId is null) return Errors("Plant seçildiğinde lokasyon da seçilmeli.");
                if (i.LocationId is { } l && !await db.Locations.AnyAsync(x => x.Id == l && x.CompanyId == i.CompanyId, ct)) return Errors("Lokasyon bu firmaya ait değil.");
                if (i.PlantId is { } p && !await db.Plants.AnyAsync(x => x.Id == p && x.LocationId == i.LocationId, ct)) return Errors("Plant bu lokasyona ait değil.");
            }
            var existing = await db.UserOrgAccess.Where(a => a.UserId == id).ToListAsync(ct);
            db.UserOrgAccess.RemoveRange(existing.Where(a => !items.Contains(new AccessItem(a.CompanyId, a.LocationId, a.PlantId))));
            foreach (var i in items.Distinct())
                if (!existing.Any(a => new AccessItem(a.CompanyId, a.LocationId, a.PlantId) == i))
                    db.UserOrgAccess.Add(new UserOrgAccess { UserId = id, CompanyId = i.CompanyId, LocationId = i.LocationId, PlantId = i.PlantId });
            return await SaveOrInUseAsync(db, "Firma, lokasyon veya plant bulunamadı.", ct);
        });
    }

    static UserRow ToRow(User u, IReadOnlyList<string> groups, TimeProvider time) => new(
        u.Id, u.UserName, u.DisplayName, u.Email, u.IsActive, u.TotpEnabled, u.MustChangePassword,
        u.LockoutEndsAt > time.GetUtcNow().UtcDateTime ? u.LockoutEndsAt : null,
        u.LastLoginAt, u.CreatedAt, groups);

    /// <summary>After the change, is the user still in a group that grants everything?</summary>
    static async Task<bool> KeepsAdministratorAsync(KernelDbContext db, Guid userId, List<MembershipItem> items, CancellationToken ct)
    {
        var allGroups = await db.GroupPermissions.Where(p => p.Permission == Permissions.All).Select(p => p.GroupId).ToListAsync(ct);
        var wasAdmin = await db.GroupMembers.AnyAsync(m => m.UserId == userId && allGroups.Contains(m.GroupId) && m.LocationId == null, ct);
        return !wasAdmin || items.Any(i => allGroups.Contains(i.GroupId) && i.LocationId is null);
    }
}
