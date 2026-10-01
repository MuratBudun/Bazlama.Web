using Bazlama.Kernel.Data;
using Bazlama.Kernel.Identity;
using Microsoft.EntityFrameworkCore;

namespace Bazlama.Modules.Identity;

public sealed record NamedOption(Guid Id, string Code, string Name);
public sealed record PeriodOption(Guid Id, string Code, string Name, DateOnly StartDate, DateOnly EndDate, bool IsClosed);
public sealed record LocationOption(Guid Id, string Code, string Name, IReadOnlyList<NamedOption> Plants);
public sealed record CompanyOption(Guid Id, string Code, string Name, IReadOnlyList<LocationOption> Locations, IReadOnlyList<PeriodOption> Periods);

/// <summary>A chosen organization context. Company and location are required; plant and period are optional.</summary>
public sealed record ContextSelection(Guid CompanyId, Guid LocationId, Guid? PlantId, Guid? PeriodId);

/// <summary>Which companies, locations, plants and periods a user may choose (from sys_user_org_access).</summary>
public sealed class OrgContextService(KernelDbContext db, TimeProvider time)
{
    public async Task<IReadOnlyList<CompanyOption>> OptionsAsync(Guid userId, CancellationToken ct = default)
    {
        var access = await db.UserOrgAccess.AsNoTracking().Where(a => a.UserId == userId).ToListAsync(ct);
        if (access.Count == 0) return [];
        var companyIds = access.Select(a => a.CompanyId).Distinct().ToList();
        var companies = await db.Companies.AsNoTracking().Where(c => companyIds.Contains(c.Id) && c.IsActive).OrderBy(c => c.Code).ToListAsync(ct);
        var locations = await db.Locations.AsNoTracking().Where(l => companyIds.Contains(l.CompanyId) && l.IsActive).OrderBy(l => l.Code).ToListAsync(ct);
        var locationIds = locations.Select(l => l.Id).ToList();
        var plants = await db.Plants.AsNoTracking().Where(p => locationIds.Contains(p.LocationId) && p.IsActive).OrderBy(p => p.Code).ToListAsync(ct);
        var periods = await db.Periods.AsNoTracking().Where(p => companyIds.Contains(p.CompanyId)).OrderByDescending(p => p.StartDate).ToListAsync(ct);

        var result = new List<CompanyOption>();
        foreach (var c in companies)
        {
            var rows = access.Where(a => a.CompanyId == c.Id).ToList();
            var wholeCompany = rows.Any(a => a.LocationId is null);
            var locs = new List<LocationOption>();
            foreach (var l in locations.Where(l => l.CompanyId == c.Id))
            {
                var locRows = rows.Where(a => a.LocationId == l.Id).ToList();
                if (!wholeCompany && locRows.Count == 0) continue;
                var wholeLocation = wholeCompany || locRows.Any(a => a.PlantId is null);
                var ps = plants.Where(p => p.LocationId == l.Id && (wholeLocation || locRows.Any(a => a.PlantId == p.Id)))
                    .Select(p => new NamedOption(p.Id, p.Code, p.Name)).ToList();
                locs.Add(new LocationOption(l.Id, l.Code, l.Name, ps));
            }
            if (locs.Count == 0) continue;
            var pers = periods.Where(p => p.CompanyId == c.Id)
                .Select(p => new PeriodOption(p.Id, p.Code, p.Name, p.StartDate, p.EndDate, p.IsClosed)).ToList();
            result.Add(new CompanyOption(c.Id, c.Code, c.Name, locs, pers));
        }
        return result;
    }

    /// <summary>Null when the selection is not among the user's options.</summary>
    public static string? Validate(IReadOnlyList<CompanyOption> options, ContextSelection s)
    {
        var company = options.FirstOrDefault(c => c.Id == s.CompanyId);
        if (company is null) return "Bu firmaya erişim yetkiniz yok.";
        var location = company.Locations.FirstOrDefault(l => l.Id == s.LocationId);
        if (location is null) return "Bu lokasyona erişim yetkiniz yok.";
        if (s.PlantId is { } plant && location.Plants.All(p => p.Id != plant)) return "Bu plant'a erişim yetkiniz yok.";
        if (s.PeriodId is { } period && company.Periods.All(p => p.Id != period)) return "Dönem bu firmaya ait değil.";
        return null;
    }

    /// <summary>
    /// The context to start with: the last one when still allowed; otherwise the only choice
    /// when there is just one. Null = the user must choose.
    /// </summary>
    public ContextSelection? Default(IReadOnlyList<CompanyOption> options, User user)
    {
        if (user is { LastCompanyId: { } lc, LastLocationId: { } ll })
        {
            var last = new ContextSelection(lc, ll, user.LastPlantId, user.LastPeriodId);
            if (Validate(options, last) is null) return last;
            if (Validate(options, last with { PlantId = null, PeriodId = null }) is null)
                return last with { PlantId = null, PeriodId = CurrentPeriod(options.First(c => c.Id == lc)) };
        }
        if (options is [var company] && company.Locations is [var location])
            return new ContextSelection(company.Id, location.Id, location.Plants is [var plant] ? plant.Id : null, CurrentPeriod(company));
        return null;
    }

    /// <summary>The open period containing today, if any.</summary>
    Guid? CurrentPeriod(CompanyOption company)
    {
        var today = DateOnly.FromDateTime(time.GetLocalNow().DateTime);
        return company.Periods.FirstOrDefault(p => !p.IsClosed && p.StartDate <= today && today <= p.EndDate)?.Id;
    }
}
