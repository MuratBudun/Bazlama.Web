namespace Bazlama.Kernel.Apps;

/// <summary>An app installed on this installation, with the metadata of its current version.</summary>
public class InstalledApp : Entity
{
    public required string Key { get; set; }
    public required string Name { get; set; }
    public required string Version { get; set; }
    /// <summary>The app definition (JSON) the tables were built from.</summary>
    public required string Metadata { get; set; }
    public DateTime InstalledAt { get; set; }
    public DateTime UpdatedAt { get; set; }
    public Guid? UpdatedBy { get; set; }
}

/// <summary>Every version that was installed (what, when, by whom, which schema changes).</summary>
public class AppVersionHistory : Entity
{
    public Guid AppId { get; set; }
    public required string Version { get; set; }
    public required string Metadata { get; set; }
    /// <summary>The schema changes applied (descriptions, one per line).</summary>
    public string? Changes { get; set; }
    public DateTime InstalledAt { get; set; }
    public Guid? InstalledBy { get; set; }
}
