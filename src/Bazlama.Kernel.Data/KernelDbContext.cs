using Bazlama.Kernel;
using Bazlama.Kernel.Apps;
using Bazlama.Kernel.Auditing;
using Bazlama.Kernel.Code;
using Bazlama.Kernel.Identity;
using Bazlama.Kernel.Organization;
using Microsoft.AspNetCore.DataProtection.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore;

namespace Bazlama.Kernel.Data;

/// <summary>
/// The platform's own (system) tables. Provider-neutral: the provider and its migrations
/// assembly come from an <see cref="IDatabaseProvider"/>.
/// </summary>
public class KernelDbContext(DbContextOptions<KernelDbContext> options) : DbContext(options), IDataProtectionKeyContext
{
    public DbSet<SystemSetting> SystemSettings => Set<SystemSetting>();

    public DbSet<Company> Companies => Set<Company>();
    public DbSet<Location> Locations => Set<Location>();
    public DbSet<Plant> Plants => Set<Plant>();
    public DbSet<Period> Periods => Set<Period>();

    public DbSet<User> Users => Set<User>();
    public DbSet<UserPasswordHistory> UserPasswordHistory => Set<UserPasswordHistory>();
    public DbSet<UserRecoveryCode> UserRecoveryCodes => Set<UserRecoveryCode>();
    public DbSet<UserOrgAccess> UserOrgAccess => Set<UserOrgAccess>();
    public DbSet<Group> Groups => Set<Group>();
    public DbSet<GroupMember> GroupMembers => Set<GroupMember>();
    public DbSet<GroupPermission> GroupPermissions => Set<GroupPermission>();
    public DbSet<UserSession> UserSessions => Set<UserSession>();

    public DbSet<AuditEvent> AuditEvents => Set<AuditEvent>();

    public DbSet<InstalledApp> Apps => Set<InstalledApp>();
    public DbSet<AppVersionHistory> AppVersions => Set<AppVersionHistory>();

    public DbSet<AppCodeFile> AppCodeFiles => Set<AppCodeFile>();
    public DbSet<AppWorkspace> AppWorkspaces => Set<AppWorkspace>();
    public DbSet<AppBuild> AppBuilds => Set<AppBuild>();
    public DbSet<CodeLibrary> CodeLibraries => Set<CodeLibrary>();
    public DbSet<CodeLibraryFile> CodeLibraryFiles => Set<CodeLibraryFile>();
    public DbSet<CodeLibraryVersion> CodeLibraryVersions => Set<CodeLibraryVersion>();
    public DbSet<AppDraft> AppDrafts => Set<AppDraft>();
    public DbSet<AppPreview> AppPreviews => Set<AppPreview>();

    /// <summary>Data Protection keys (TOTP secrets, cookies): in the database, so every node and restart shares them.</summary>
    public DbSet<DataProtectionKey> DataProtectionKeys => Set<DataProtectionKey>();

    const int Code = 50, Name = 200;

    protected override void OnModelCreating(ModelBuilder model)
    {
        model.Entity<SystemSetting>(e =>
        {
            e.ToTable("sys_settings");
            e.HasKey(x => x.Key);
            e.Property(x => x.Key).HasMaxLength(200);
            e.Property(x => x.Value).HasMaxLength(4000);
        });

        model.Entity<Company>(e =>
        {
            e.ToTable("sys_companies");
            e.Property(x => x.Code).HasMaxLength(Code);
            e.Property(x => x.Name).HasMaxLength(Name);
            e.HasIndex(x => x.Code).IsUnique();
        });
        model.Entity<Location>(e =>
        {
            e.ToTable("sys_locations");
            e.Property(x => x.Code).HasMaxLength(Code);
            e.Property(x => x.Name).HasMaxLength(Name);
            e.Property(x => x.TimeZone).HasMaxLength(100);
            e.HasOne<Company>().WithMany().HasForeignKey(x => x.CompanyId).OnDelete(DeleteBehavior.Restrict);
            e.HasIndex(x => new { x.CompanyId, x.Code }).IsUnique();
        });
        model.Entity<Plant>(e =>
        {
            e.ToTable("sys_plants");
            e.Property(x => x.Code).HasMaxLength(Code);
            e.Property(x => x.Name).HasMaxLength(Name);
            e.HasOne<Location>().WithMany().HasForeignKey(x => x.LocationId).OnDelete(DeleteBehavior.Restrict);
            e.HasIndex(x => new { x.LocationId, x.Code }).IsUnique();
        });
        model.Entity<Period>(e =>
        {
            e.ToTable("sys_periods");
            e.Property(x => x.Code).HasMaxLength(Code);
            e.Property(x => x.Name).HasMaxLength(Name);
            e.HasOne<Company>().WithMany().HasForeignKey(x => x.CompanyId).OnDelete(DeleteBehavior.Restrict);
            e.HasIndex(x => new { x.CompanyId, x.Code }).IsUnique();
        });

        model.Entity<User>(e =>
        {
            e.ToTable("sys_users");
            e.Property(x => x.UserName).HasMaxLength(100);
            e.Property(x => x.NormalizedUserName).HasMaxLength(100);
            e.Property(x => x.DisplayName).HasMaxLength(Name);
            e.Property(x => x.Email).HasMaxLength(Name);
            e.Property(x => x.PasswordHash).HasMaxLength(500);
            e.Property(x => x.TotpSecret).HasMaxLength(1000);
            e.HasIndex(x => x.NormalizedUserName).IsUnique();
        });
        model.Entity<UserPasswordHistory>(e =>
        {
            e.ToTable("sys_user_password_history");
            e.Property(x => x.PasswordHash).HasMaxLength(500);
            e.HasOne<User>().WithMany().HasForeignKey(x => x.UserId).OnDelete(DeleteBehavior.Cascade);
        });
        model.Entity<UserRecoveryCode>(e =>
        {
            e.ToTable("sys_user_recovery_codes");
            e.Property(x => x.CodeHash).HasMaxLength(500);
            e.HasOne<User>().WithMany().HasForeignKey(x => x.UserId).OnDelete(DeleteBehavior.Cascade);
        });
        model.Entity<UserOrgAccess>(e =>
        {
            e.ToTable("sys_user_org_access");
            e.HasOne<User>().WithMany().HasForeignKey(x => x.UserId).OnDelete(DeleteBehavior.Cascade);
            e.HasOne<Company>().WithMany().HasForeignKey(x => x.CompanyId).OnDelete(DeleteBehavior.Restrict);
            e.HasOne<Location>().WithMany().HasForeignKey(x => x.LocationId).OnDelete(DeleteBehavior.Restrict);
            e.HasOne<Plant>().WithMany().HasForeignKey(x => x.PlantId).OnDelete(DeleteBehavior.Restrict);
        });
        model.Entity<Group>(e =>
        {
            e.ToTable("sys_groups");
            e.Property(x => x.Code).HasMaxLength(Code);
            e.Property(x => x.Name).HasMaxLength(Name);
            e.Property(x => x.Description).HasMaxLength(1000);
            e.HasIndex(x => x.Code).IsUnique();
        });
        model.Entity<GroupMember>(e =>
        {
            e.ToTable("sys_group_members");
            e.HasOne<Group>().WithMany().HasForeignKey(x => x.GroupId).OnDelete(DeleteBehavior.Cascade);
            e.HasOne<User>().WithMany().HasForeignKey(x => x.UserId).OnDelete(DeleteBehavior.Cascade);
            e.HasOne<Location>().WithMany().HasForeignKey(x => x.LocationId).OnDelete(DeleteBehavior.Restrict);
            e.HasIndex(x => new { x.GroupId, x.UserId });
        });
        model.Entity<GroupPermission>(e =>
        {
            e.ToTable("sys_group_permissions");
            e.Property(x => x.Permission).HasMaxLength(200);
            e.HasOne<Group>().WithMany().HasForeignKey(x => x.GroupId).OnDelete(DeleteBehavior.Cascade);
            e.HasIndex(x => new { x.GroupId, x.Permission }).IsUnique();
        });
        model.Entity<UserSession>(e =>
        {
            e.ToTable("sys_user_sessions");
            e.Property(x => x.Status).HasConversion<string>().HasMaxLength(30);
            e.Property(x => x.Channel).HasMaxLength(20);
            e.Property(x => x.EndReason).HasMaxLength(50);
            e.Property(x => x.IpAddress).HasMaxLength(64);
            e.Property(x => x.UserAgent).HasMaxLength(500);
            e.HasOne<User>().WithMany().HasForeignKey(x => x.UserId).OnDelete(DeleteBehavior.Cascade);
            e.HasIndex(x => new { x.UserId, x.Status });
        });

        model.Entity<AuditEvent>(e =>
        {
            e.ToTable("sys_audit_events");
            e.Property(x => x.Category).HasMaxLength(20);
            e.Property(x => x.Action).HasMaxLength(100);
            e.Property(x => x.UserName).HasMaxLength(100);
            e.Property(x => x.EntityType).HasMaxLength(100);
            e.Property(x => x.EntityId).HasMaxLength(100);
            e.Property(x => x.IpAddress).HasMaxLength(64);
            e.HasIndex(x => x.At);
            e.HasIndex(x => new { x.EntityType, x.EntityId });
        });

        model.Entity<InstalledApp>(e =>
        {
            e.ToTable("sys_apps");
            e.Property(x => x.Key).HasMaxLength(Code);
            e.Property(x => x.Name).HasMaxLength(Name);
            e.Property(x => x.Version).HasMaxLength(Code);
            e.HasIndex(x => x.Key).IsUnique();
        });
        model.Entity<AppVersionHistory>(e =>
        {
            e.ToTable("sys_app_versions");
            e.Property(x => x.Version).HasMaxLength(Code);
            e.HasOne<InstalledApp>().WithMany().HasForeignKey(x => x.AppId).OnDelete(DeleteBehavior.Cascade);
            e.HasIndex(x => x.AppId);
        });

        model.Entity<AppCodeFile>(e =>
        {
            e.ToTable("sys_app_code_files");
            e.Property(x => x.AppKey).HasMaxLength(Code);
            e.Property(x => x.Path).HasMaxLength(Name);
            e.HasIndex(x => new { x.AppKey, x.Path }).IsUnique();
        });
        model.Entity<AppWorkspace>(e =>
        {
            e.ToTable("sys_app_workspaces");
            e.Property(x => x.AppKey).HasMaxLength(Code);
            e.HasIndex(x => x.AppKey).IsUnique();
        });
        model.Entity<AppBuild>(e =>
        {
            e.ToTable("sys_app_builds");
            e.Property(x => x.AppKey).HasMaxLength(Code);
            e.Property(x => x.AppVersion).HasMaxLength(Code);
            e.Property(x => x.Hash).HasMaxLength(64);
            e.HasIndex(x => new { x.AppKey, x.Number }).IsUnique();
        });
        model.Entity<CodeLibrary>(e =>
        {
            e.ToTable("sys_code_libraries");
            e.Property(x => x.Key).HasMaxLength(Code);
            e.Property(x => x.Name).HasMaxLength(Name);
            e.Property(x => x.Description).HasMaxLength(1000);
            e.HasIndex(x => x.Key).IsUnique();
        });
        model.Entity<CodeLibraryFile>(e =>
        {
            e.ToTable("sys_code_library_files");
            e.Property(x => x.Path).HasMaxLength(Name);
            e.HasOne<CodeLibrary>().WithMany().HasForeignKey(x => x.LibraryId).OnDelete(DeleteBehavior.Cascade);
            e.HasIndex(x => new { x.LibraryId, x.Path }).IsUnique();
        });
        model.Entity<CodeLibraryVersion>(e =>
        {
            e.ToTable("sys_code_library_versions");
            e.Property(x => x.Version).HasMaxLength(Code);
            e.Property(x => x.Hash).HasMaxLength(64);
            e.HasOne<CodeLibrary>().WithMany().HasForeignKey(x => x.LibraryId).OnDelete(DeleteBehavior.Restrict);
            e.HasIndex(x => new { x.LibraryId, x.Version }).IsUnique();
        });

        model.Entity<AppDraft>(e =>
        {
            e.ToTable("sys_app_drafts");
            e.Property(x => x.AppKey).HasMaxLength(Code);
            e.HasIndex(x => x.AppKey).IsUnique();
        });

        model.Entity<AppPreview>(e =>
        {
            e.ToTable("sys_app_previews");
            e.Property(x => x.AppKey).HasMaxLength(Code);
            e.HasIndex(x => x.AppKey).IsUnique();
        });

        model.Entity<DataProtectionKey>().ToTable("sys_data_protection_keys");
    }
}
