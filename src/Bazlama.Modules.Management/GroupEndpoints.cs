using Bazlama.Kernel.Data;
using Bazlama.Kernel.Identity;
using Bazlama.Modules.Identity;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Routing;
using Microsoft.EntityFrameworkCore;
using static Bazlama.Modules.Management.Http;

namespace Bazlama.Modules.Management;

public sealed record GroupRow(Guid Id, string Code, string Name, string? Description, bool RequireMfa, bool IsSystem, int MemberCount, IReadOnlyList<string> Permissions);
public sealed record GroupSave(string Code, string Name, string? Description, bool RequireMfa);
public sealed record MemberItem(Guid UserId, Guid? LocationId);
public sealed record MemberRow(Guid UserId, string UserName, string DisplayName, Guid? LocationId);
public sealed record PermissionInfo(string Key, string Title);

static class GroupEndpoints
{
    public static void MapGroupEndpoints(this RouteGroupBuilder api)
    {
        var groups = api.MapGroup("/groups").RequirePermission(Permissions.Groups);

        groups.MapGet("/permissions", () => Permissions.Catalog.Select(p => new PermissionInfo(p.Key, p.Title)));

        groups.MapGet("/", async (KernelDbContext db, CancellationToken ct) =>
        {
            var counts = await db.GroupMembers.GroupBy(m => m.GroupId).Select(g => new { g.Key, Count = g.Select(m => m.UserId).Distinct().Count() }).ToDictionaryAsync(x => x.Key, x => x.Count, ct);
            var perms = (await db.GroupPermissions.AsNoTracking().ToListAsync(ct)).ToLookup(p => p.GroupId, p => p.Permission);
            var list = await db.Groups.AsNoTracking().OrderBy(g => g.Name).ToListAsync(ct);
            return list.Select(g => new GroupRow(g.Id, g.Code, g.Name, g.Description, g.RequireMfa, g.IsSystem,
                counts.GetValueOrDefault(g.Id), [.. perms[g.Id].Order()]));
        });

        groups.MapPost("/", async (GroupSave r, KernelDbContext db, CancellationToken ct) =>
        {
            var errors = await ValidateAsync(db, r, null, ct);
            if (errors.Count > 0) return Errors(errors);
            var group = new Group { Code = r.Code.Trim().ToUpperInvariant(), Name = r.Name.Trim(), Description = r.Description?.Trim(), RequireMfa = r.RequireMfa };
            db.Groups.Add(group);
            await db.SaveChangesAsync(ct);
            return Results.Ok(new { group.Id });
        });

        groups.MapPut("/{id:guid}", async (Guid id, GroupSave r, KernelDbContext db, CancellationToken ct) =>
        {
            var group = await db.Groups.FirstOrDefaultAsync(g => g.Id == id, ct);
            if (group is null) return Results.NotFound();
            var errors = await ValidateAsync(db, r, id, ct);
            if (errors.Count > 0) return Errors(errors);
            if (!group.IsSystem) group.Code = r.Code.Trim().ToUpperInvariant();
            group.Name = r.Name.Trim();
            group.Description = r.Description?.Trim();
            group.RequireMfa = r.RequireMfa;
            await db.SaveChangesAsync(ct);
            return Results.NoContent();
        });

        groups.MapDelete("/{id:guid}", async (Guid id, KernelDbContext db, CancellationToken ct) =>
        {
            var group = await db.Groups.FirstOrDefaultAsync(g => g.Id == id, ct);
            if (group is null) return Results.NotFound();
            if (group.IsSystem) return Errors("Sistem grubu silinemez.");
            db.Groups.Remove(group);
            var result = await SaveOrInUseAsync(db, "Grup kullanımda.", ct);
            SessionStore.PermissionsChanged();
            return result;
        });

        groups.MapPut("/{id:guid}/permissions", async (Guid id, List<string> permissions, KernelDbContext db, CancellationToken ct) =>
        {
            var group = await db.Groups.FirstOrDefaultAsync(g => g.Id == id, ct);
            if (group is null) return Results.NotFound();
            var known = Permissions.Catalog.Select(p => p.Key).ToHashSet();
            var wanted = permissions.Where(p => !Blank(p)).Select(p => p.Trim()).ToHashSet();
            if (wanted.FirstOrDefault(p => !known.Contains(p)) is { } unknown) return Errors($"Bilinmeyen izin: {unknown}");
            if (group.IsSystem && !wanted.Contains(Permissions.All)) return Errors("Yöneticiler grubunun 'Tüm yetkiler' izni kaldırılamaz.");

            var existing = await db.GroupPermissions.Where(p => p.GroupId == id).ToListAsync(ct);
            db.GroupPermissions.RemoveRange(existing.Where(p => !wanted.Contains(p.Permission)));
            foreach (var p in wanted.Where(p => existing.All(e => e.Permission != p)))
                db.GroupPermissions.Add(new GroupPermission { GroupId = id, Permission = p });
            await db.SaveChangesAsync(ct);
            SessionStore.PermissionsChanged();
            return Results.NoContent();
        });

        groups.MapGet("/{id:guid}/members", async (Guid id, KernelDbContext db, CancellationToken ct) =>
            await (from m in db.GroupMembers
                   join u in db.Users on m.UserId equals u.Id
                   where m.GroupId == id
                   orderby u.UserName
                   select new MemberRow(u.Id, u.UserName, u.DisplayName, m.LocationId)).ToListAsync(ct));

        groups.MapPut("/{id:guid}/members", async (Guid id, List<MemberItem> items, KernelDbContext db, CurrentSession current, CancellationToken ct) =>
        {
            var group = await db.Groups.FirstOrDefaultAsync(g => g.Id == id, ct);
            if (group is null) return Results.NotFound();
            if (group.IsSystem)
            {
                if (!items.Any(i => i.LocationId is null)) return Errors("Yöneticiler grubunda tüm lokasyonlarda geçerli en az bir üye olmalı.");
                if (!items.Any(i => i.UserId == current.Snapshot!.UserId && i.LocationId is null)) return Errors("Kendinizi Yöneticiler grubundan çıkaramazsınız.");
            }
            var existing = await db.GroupMembers.Where(m => m.GroupId == id).ToListAsync(ct);
            db.GroupMembers.RemoveRange(existing.Where(m => !items.Any(i => i.UserId == m.UserId && i.LocationId == m.LocationId)));
            foreach (var i in items.DistinctBy(i => (i.UserId, i.LocationId)))
                if (!existing.Any(m => m.UserId == i.UserId && m.LocationId == i.LocationId))
                    db.GroupMembers.Add(new GroupMember { GroupId = id, UserId = i.UserId, LocationId = i.LocationId });
            var result = await SaveOrInUseAsync(db, "Kullanıcı veya lokasyon bulunamadı.", ct);
            SessionStore.PermissionsChanged();
            return result;
        });
    }

    static async Task<List<string>> ValidateAsync(KernelDbContext db, GroupSave r, Guid? id, CancellationToken ct)
    {
        var errors = new List<string>();
        if (Blank(r.Code)) errors.Add("Grup kodu gerekli.");
        else if (await db.Groups.AnyAsync(g => g.Code == r.Code.Trim().ToUpperInvariant() && g.Id != id, ct)) errors.Add("Bu grup kodu kullanılıyor.");
        if (Blank(r.Name)) errors.Add("Grup adı gerekli.");
        return errors;
    }
}
