namespace Bazlama.Kernel.Organization;

/*
 * Company → Location → Plant: three fixed levels, not a tree. A location may have no plants.
 * Periods belong to a company.
 */

public class Company : Entity, IAudited
{
    public required string Code { get; set; }
    public required string Name { get; set; }
    public bool IsActive { get; set; } = true;
}

public class Location : Entity, IAudited
{
    public Guid CompanyId { get; set; }
    public required string Code { get; set; }
    public required string Name { get; set; }
    /// <summary>IANA or Windows time zone id; null = the server's.</summary>
    public string? TimeZone { get; set; }
    public bool IsActive { get; set; } = true;
}

public class Plant : Entity, IAudited
{
    public Guid LocationId { get; set; }
    public required string Code { get; set; }
    public required string Name { get; set; }
    public bool IsActive { get; set; } = true;
}

public class Period : Entity, IAudited
{
    public Guid CompanyId { get; set; }
    public required string Code { get; set; }
    public required string Name { get; set; }
    public DateOnly StartDate { get; set; }
    public DateOnly EndDate { get; set; }
    /// <summary>A closed period is read-only.</summary>
    public bool IsClosed { get; set; }
}
