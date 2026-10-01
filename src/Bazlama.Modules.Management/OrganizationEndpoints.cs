using Bazlama.Kernel.Data;
using Bazlama.Kernel.Identity;
using Bazlama.Kernel.Organization;
using Bazlama.Modules.Identity;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Routing;
using Microsoft.EntityFrameworkCore;
using static Bazlama.Modules.Management.Http;

namespace Bazlama.Modules.Management;

public sealed record PlantNode(Guid Id, Guid LocationId, string Code, string Name, bool IsActive);
public sealed record LocationNode(Guid Id, Guid CompanyId, string Code, string Name, string? TimeZone, bool IsActive, IReadOnlyList<PlantNode> Plants);
public sealed record PeriodNode(Guid Id, Guid CompanyId, string Code, string Name, DateOnly StartDate, DateOnly EndDate, bool IsClosed);
public sealed record CompanyNode(Guid Id, string Code, string Name, bool IsActive, IReadOnlyList<LocationNode> Locations, IReadOnlyList<PeriodNode> Periods);

public sealed record CompanySave(string Code, string Name, bool IsActive);
public sealed record LocationSave(Guid CompanyId, string Code, string Name, string? TimeZone, bool IsActive);
public sealed record PlantSave(Guid LocationId, string Code, string Name, bool IsActive);
public sealed record PeriodSave(Guid CompanyId, string Code, string Name, DateOnly StartDate, DateOnly EndDate, bool IsClosed);

/// <summary>Company → location → plant, and the companies' periods. Codes are unique within the parent.</summary>
static class OrganizationEndpoints
{
    const string InUse = "Kayıt kullanımda (alt kayıtları veya kullanıcı yetkileri var); önce onları kaldırın ya da pasif yapın.";

    public static void MapOrganizationEndpoints(this RouteGroupBuilder api)
    {
        var org = api.MapGroup("/organization").RequirePermission(Permissions.Organization);

        org.MapGet("/", async (KernelDbContext db, CancellationToken ct) =>
        {
            var companies = await db.Companies.AsNoTracking().OrderBy(c => c.Code).ToListAsync(ct);
            var locations = await db.Locations.AsNoTracking().OrderBy(l => l.Code).ToListAsync(ct);
            var plants = await db.Plants.AsNoTracking().OrderBy(p => p.Code).ToListAsync(ct);
            var periods = await db.Periods.AsNoTracking().OrderByDescending(p => p.StartDate).ToListAsync(ct);
            return companies.Select(c => new CompanyNode(c.Id, c.Code, c.Name, c.IsActive,
                [.. locations.Where(l => l.CompanyId == c.Id).Select(l => new LocationNode(l.Id, l.CompanyId, l.Code, l.Name, l.TimeZone, l.IsActive,
                    [.. plants.Where(p => p.LocationId == l.Id).Select(p => new PlantNode(p.Id, p.LocationId, p.Code, p.Name, p.IsActive))]))],
                [.. periods.Where(p => p.CompanyId == c.Id).Select(p => new PeriodNode(p.Id, p.CompanyId, p.Code, p.Name, p.StartDate, p.EndDate, p.IsClosed))]));
        });

        // Companies
        org.MapPost("/companies", async (CompanySave r, KernelDbContext db, CancellationToken ct) =>
        {
            if (CodeName(r.Code, r.Name) is { } e) return Errors(e);
            if (await db.Companies.AnyAsync(c => c.Code == r.Code.Trim(), ct)) return Errors("Bu firma kodu kullanılıyor.");
            var c = new Company { Code = r.Code.Trim(), Name = r.Name.Trim(), IsActive = r.IsActive };
            db.Companies.Add(c);
            await db.SaveChangesAsync(ct);
            return Results.Ok(new { c.Id });
        });
        org.MapPut("/companies/{id:guid}", async (Guid id, CompanySave r, KernelDbContext db, CancellationToken ct) =>
        {
            var c = await db.Companies.FirstOrDefaultAsync(x => x.Id == id, ct);
            if (c is null) return Results.NotFound();
            if (CodeName(r.Code, r.Name) is { } e) return Errors(e);
            if (await db.Companies.AnyAsync(x => x.Code == r.Code.Trim() && x.Id != id, ct)) return Errors("Bu firma kodu kullanılıyor.");
            (c.Code, c.Name, c.IsActive) = (r.Code.Trim(), r.Name.Trim(), r.IsActive);
            await db.SaveChangesAsync(ct);
            return Results.NoContent();
        });
        org.MapDelete("/companies/{id:guid}", async (Guid id, KernelDbContext db, CancellationToken ct) =>
        {
            var c = await db.Companies.FirstOrDefaultAsync(x => x.Id == id, ct);
            if (c is null) return Results.NotFound();
            db.Companies.Remove(c);
            return await SaveOrInUseAsync(db, InUse, ct);
        });

        // Locations
        org.MapPost("/locations", async (LocationSave r, KernelDbContext db, CancellationToken ct) =>
        {
            if (CodeName(r.Code, r.Name) is { } e) return Errors(e);
            if (!await db.Companies.AnyAsync(c => c.Id == r.CompanyId, ct)) return Errors("Firma bulunamadı.");
            if (await db.Locations.AnyAsync(l => l.CompanyId == r.CompanyId && l.Code == r.Code.Trim(), ct)) return Errors("Bu lokasyon kodu firmada kullanılıyor.");
            if (TimeZoneError(r.TimeZone) is { } tz) return Errors(tz);
            var l = new Location { CompanyId = r.CompanyId, Code = r.Code.Trim(), Name = r.Name.Trim(), TimeZone = Blank(r.TimeZone) ? null : r.TimeZone!.Trim(), IsActive = r.IsActive };
            db.Locations.Add(l);
            await db.SaveChangesAsync(ct);
            return Results.Ok(new { l.Id });
        });
        org.MapPut("/locations/{id:guid}", async (Guid id, LocationSave r, KernelDbContext db, CancellationToken ct) =>
        {
            var l = await db.Locations.FirstOrDefaultAsync(x => x.Id == id, ct);
            if (l is null) return Results.NotFound();
            if (CodeName(r.Code, r.Name) is { } e) return Errors(e);
            if (await db.Locations.AnyAsync(x => x.CompanyId == l.CompanyId && x.Code == r.Code.Trim() && x.Id != id, ct)) return Errors("Bu lokasyon kodu firmada kullanılıyor.");
            if (TimeZoneError(r.TimeZone) is { } tz) return Errors(tz);
            (l.Code, l.Name, l.TimeZone, l.IsActive) = (r.Code.Trim(), r.Name.Trim(), Blank(r.TimeZone) ? null : r.TimeZone!.Trim(), r.IsActive);
            await db.SaveChangesAsync(ct);
            return Results.NoContent();
        });
        org.MapDelete("/locations/{id:guid}", async (Guid id, KernelDbContext db, CancellationToken ct) =>
        {
            var l = await db.Locations.FirstOrDefaultAsync(x => x.Id == id, ct);
            if (l is null) return Results.NotFound();
            db.Locations.Remove(l);
            return await SaveOrInUseAsync(db, InUse, ct);
        });

        // Plants
        org.MapPost("/plants", async (PlantSave r, KernelDbContext db, CancellationToken ct) =>
        {
            if (CodeName(r.Code, r.Name) is { } e) return Errors(e);
            if (!await db.Locations.AnyAsync(l => l.Id == r.LocationId, ct)) return Errors("Lokasyon bulunamadı.");
            if (await db.Plants.AnyAsync(p => p.LocationId == r.LocationId && p.Code == r.Code.Trim(), ct)) return Errors("Bu plant kodu lokasyonda kullanılıyor.");
            var p = new Plant { LocationId = r.LocationId, Code = r.Code.Trim(), Name = r.Name.Trim(), IsActive = r.IsActive };
            db.Plants.Add(p);
            await db.SaveChangesAsync(ct);
            return Results.Ok(new { p.Id });
        });
        org.MapPut("/plants/{id:guid}", async (Guid id, PlantSave r, KernelDbContext db, CancellationToken ct) =>
        {
            var p = await db.Plants.FirstOrDefaultAsync(x => x.Id == id, ct);
            if (p is null) return Results.NotFound();
            if (CodeName(r.Code, r.Name) is { } e) return Errors(e);
            if (await db.Plants.AnyAsync(x => x.LocationId == p.LocationId && x.Code == r.Code.Trim() && x.Id != id, ct)) return Errors("Bu plant kodu lokasyonda kullanılıyor.");
            (p.Code, p.Name, p.IsActive) = (r.Code.Trim(), r.Name.Trim(), r.IsActive);
            await db.SaveChangesAsync(ct);
            return Results.NoContent();
        });
        org.MapDelete("/plants/{id:guid}", async (Guid id, KernelDbContext db, CancellationToken ct) =>
        {
            var p = await db.Plants.FirstOrDefaultAsync(x => x.Id == id, ct);
            if (p is null) return Results.NotFound();
            db.Plants.Remove(p);
            return await SaveOrInUseAsync(db, InUse, ct);
        });

        // Periods
        org.MapPost("/periods", async (PeriodSave r, KernelDbContext db, CancellationToken ct) =>
        {
            if (!await db.Companies.AnyAsync(c => c.Id == r.CompanyId, ct)) return Errors("Firma bulunamadı.");
            var errors = await ValidatePeriodAsync(db, r, null, ct);
            if (errors.Count > 0) return Errors(errors);
            var p = new Period { CompanyId = r.CompanyId, Code = r.Code.Trim(), Name = r.Name.Trim(), StartDate = r.StartDate, EndDate = r.EndDate, IsClosed = r.IsClosed };
            db.Periods.Add(p);
            await db.SaveChangesAsync(ct);
            return Results.Ok(new { p.Id });
        });
        org.MapPut("/periods/{id:guid}", async (Guid id, PeriodSave r, KernelDbContext db, CancellationToken ct) =>
        {
            var p = await db.Periods.FirstOrDefaultAsync(x => x.Id == id, ct);
            if (p is null) return Results.NotFound();
            var errors = await ValidatePeriodAsync(db, r with { CompanyId = p.CompanyId }, id, ct);
            if (errors.Count > 0) return Errors(errors);
            (p.Code, p.Name, p.StartDate, p.EndDate, p.IsClosed) = (r.Code.Trim(), r.Name.Trim(), r.StartDate, r.EndDate, r.IsClosed);
            await db.SaveChangesAsync(ct);
            return Results.NoContent();
        });
        org.MapDelete("/periods/{id:guid}", async (Guid id, KernelDbContext db, CancellationToken ct) =>
        {
            var p = await db.Periods.FirstOrDefaultAsync(x => x.Id == id, ct);
            if (p is null) return Results.NotFound();
            db.Periods.Remove(p);
            return await SaveOrInUseAsync(db, InUse, ct);
        });
    }

    static string? CodeName(string? code, string? name) =>
        Blank(code) ? "Kod gerekli." : Blank(name) ? "Ad gerekli." : null;

    static string? TimeZoneError(string? id)
    {
        if (Blank(id)) return null;
        return TimeZoneInfo.TryFindSystemTimeZoneById(id!.Trim(), out _) ? null : $"Saat dilimi bulunamadı: {id}";
    }

    /// <summary>Periods of a company must not overlap: a date belongs to one period.</summary>
    static async Task<List<string>> ValidatePeriodAsync(KernelDbContext db, PeriodSave r, Guid? id, CancellationToken ct)
    {
        var errors = new List<string>();
        if (CodeName(r.Code, r.Name) is { } e) errors.Add(e);
        if (r.EndDate < r.StartDate) errors.Add("Bitiş tarihi başlangıçtan önce olamaz.");
        if (!Blank(r.Code) && await db.Periods.AnyAsync(p => p.CompanyId == r.CompanyId && p.Code == r.Code.Trim() && p.Id != id, ct))
            errors.Add("Bu dönem kodu firmada kullanılıyor.");
        if (await db.Periods.AnyAsync(p => p.CompanyId == r.CompanyId && p.Id != id && p.StartDate <= r.EndDate && r.StartDate <= p.EndDate, ct))
            errors.Add("Dönem, firmanın başka bir dönemiyle çakışıyor.");
        return errors;
    }
}
