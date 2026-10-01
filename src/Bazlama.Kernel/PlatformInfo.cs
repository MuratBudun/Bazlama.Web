namespace Bazlama.Kernel;

/// <summary>What this installation is: its environment mode and the platform version.</summary>
public sealed record PlatformInfo(EnvironmentMode Mode, string Version)
{
    /// <summary>Designers and code editing are open only in a development installation.</summary>
    public bool CanDevelop => Mode == EnvironmentMode.Development;
}
