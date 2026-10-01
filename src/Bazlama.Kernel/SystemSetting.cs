namespace Bazlama.Kernel;

/// <summary>An installation-wide setting (key/value).</summary>
public class SystemSetting
{
    public required string Key { get; set; }
    public string? Value { get; set; }
    /// <summary>UTC.</summary>
    public DateTime UpdatedAt { get; set; }
}
