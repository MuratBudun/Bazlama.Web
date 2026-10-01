namespace Bazlama.Kernel.Auditing;

/// <summary>One audit record: a security event (sign-in, lockout…) or a data change.</summary>
public class AuditEvent : Entity
{
    public DateTime At { get; set; }
    /// <summary>security | data</summary>
    public required string Category { get; set; }
    /// <summary>e.g. login.success, User.update.</summary>
    public required string Action { get; set; }
    public Guid? UserId { get; set; }
    public string? UserName { get; set; }
    public Guid? SessionId { get; set; }
    public string? EntityType { get; set; }
    public string? EntityId { get; set; }
    /// <summary>JSON: changed fields (old/new) or event details.</summary>
    public string? Data { get; set; }
    public string? IpAddress { get; set; }
}

/// <summary>Who is acting now (the host implements it from the current session).</summary>
public interface IAuditActor
{
    Guid? UserId { get; }
    string? UserName { get; }
    Guid? SessionId { get; }
    string? IpAddress { get; }
}

/// <summary>No one: startup, background work, tests.</summary>
public sealed class SystemAuditActor : IAuditActor
{
    public static readonly SystemAuditActor Instance = new();
    public Guid? UserId => null;
    public string? UserName => "system";
    public Guid? SessionId => null;
    public string? IpAddress => null;
}
