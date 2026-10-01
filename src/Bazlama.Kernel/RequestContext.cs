namespace Bazlama.Kernel;

/// <summary>
/// Who is asking and in which organization context. The identity module provides it from the
/// session; the data engine uses it for scope filters, permissions and audit.
/// </summary>
public interface IRequestContext
{
    Guid? UserId { get; }
    string? UserName { get; }
    Guid? SessionId { get; }
    string? IpAddress { get; }

    Guid? CompanyId { get; }
    Guid? LocationId { get; }
    Guid? PlantId { get; }
    Guid? PeriodId { get; }

    bool HasPermission(string permission);
}
