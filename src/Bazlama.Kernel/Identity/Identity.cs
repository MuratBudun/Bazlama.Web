namespace Bazlama.Kernel.Identity;

public class User : Entity, IAudited
{
    public required string UserName { get; set; }
    /// <summary>Lower-case invariant <see cref="UserName"/>; unique.</summary>
    public required string NormalizedUserName { get; set; }
    public required string DisplayName { get; set; }
    public string? Email { get; set; }
    public bool IsActive { get; set; } = true;

    public string? PasswordHash { get; set; }
    public DateTime? PasswordChangedAt { get; set; }
    public bool MustChangePassword { get; set; }
    public int FailedLoginCount { get; set; }
    public DateTime? LockoutEndsAt { get; set; }

    /// <summary>TOTP secret, encrypted with Data Protection.</summary>
    public string? TotpSecret { get; set; }
    public bool TotpEnabled { get; set; }
    /// <summary>Time step of the last accepted code: a code cannot be used twice.</summary>
    public long? TotpLastStep { get; set; }

    public DateTime CreatedAt { get; set; }
    public DateTime? LastLoginAt { get; set; }

    /// <summary>The organization context chosen last time (offered again at the next sign-in).</summary>
    public Guid? LastCompanyId { get; set; }
    public Guid? LastLocationId { get; set; }
    public Guid? LastPlantId { get; set; }
    public Guid? LastPeriodId { get; set; }

    public static string Normalize(string userName) => userName.Trim().ToLowerInvariant();
}

public class UserPasswordHistory : Entity
{
    public Guid UserId { get; set; }
    public required string PasswordHash { get; set; }
    public DateTime CreatedAt { get; set; }
}

public class UserRecoveryCode : Entity
{
    public Guid UserId { get; set; }
    public required string CodeHash { get; set; }
    public DateTime? UsedAt { get; set; }
}

/// <summary>
/// Which part of the organization a user may work in. Null levels mean "all below":
/// (company) = every location and plant of it, (company, location) = every plant of the location.
/// </summary>
public class UserOrgAccess : Entity, IAudited
{
    public Guid UserId { get; set; }
    public Guid CompanyId { get; set; }
    public Guid? LocationId { get; set; }
    public Guid? PlantId { get; set; }
}

/// <summary>Groups are the roles: permissions are granted to groups.</summary>
public class Group : Entity, IAudited
{
    public required string Code { get; set; }
    public required string Name { get; set; }
    public string? Description { get; set; }
    /// <summary>Members must use a second factor.</summary>
    public bool RequireMfa { get; set; }
    /// <summary>Created by the platform (Administrators); cannot be deleted.</summary>
    public bool IsSystem { get; set; }
}

/// <summary>Membership; with a location, the group applies only while that location is active.</summary>
public class GroupMember : Entity, IAudited
{
    public Guid GroupId { get; set; }
    public Guid UserId { get; set; }
    public Guid? LocationId { get; set; }
}

public class GroupPermission : Entity, IAudited
{
    public Guid GroupId { get; set; }
    public required string Permission { get; set; }
}

public enum SessionStatus
{
    /// <summary>Password accepted; a new password must be set first.</summary>
    PendingPasswordChange,
    /// <summary>Password accepted; MFA is required but not set up yet.</summary>
    PendingMfaEnrollment,
    /// <summary>Password accepted; waiting for the second factor.</summary>
    PendingMfa,
    Active,
    Ended,
}

/// <summary>A sign-in. The cookie carries only its id; the state lives here.</summary>
public class UserSession : Entity
{
    public Guid UserId { get; set; }
    public SessionStatus Status { get; set; }
    public required string Channel { get; set; }
    public DateTime CreatedAt { get; set; }
    public DateTime LastSeenAt { get; set; }
    public DateTime? EndedAt { get; set; }
    /// <summary>logout, revoked, expired, replaced.</summary>
    public string? EndReason { get; set; }
    public string? IpAddress { get; set; }
    public string? UserAgent { get; set; }

    public Guid? CompanyId { get; set; }
    public Guid? LocationId { get; set; }
    public Guid? PlantId { get; set; }
    public Guid? PeriodId { get; set; }
}
