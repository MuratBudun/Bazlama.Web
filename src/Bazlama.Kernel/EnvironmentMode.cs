namespace Bazlama.Kernel;

/// <summary>
/// What an installation is for. In Test and Production the designers are closed and apps
/// change only by import (docs/architecture.md, "Ortam modu").
/// </summary>
public enum EnvironmentMode
{
    Development,
    Test,
    Production,
}
