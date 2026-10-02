namespace Bazlama.Kernel.Code;

/// <summary>A C# file of an app's workspace (Development; what the next build compiles).</summary>
public class AppCodeFile : Entity
{
    public required string AppKey { get; set; }
    /// <summary>"Siparis/SiparisEvents.cs"</summary>
    public required string Path { get; set; }
    public required string Content { get; set; }
    public DateTime UpdatedAt { get; set; }
    public Guid? UpdatedBy { get; set; }
}

/// <summary>An app's workspace settings: the code library versions it uses.</summary>
public class AppWorkspace : Entity
{
    public required string AppKey { get; set; }
    /// <summary>JSON: [{ "key": "ortak", "version": "1.0.0" }]</summary>
    public string Libraries { get; set; } = "[]";
}

/// <summary>A compiled build of an app's code. The active one is loaded at runtime.</summary>
public class AppBuild : Entity
{
    public required string AppKey { get; set; }
    public int Number { get; set; }
    /// <summary>The app version (metadata) it was compiled against.</summary>
    public required string AppVersion { get; set; }
    public required byte[] Image { get; set; }
    /// <summary>SHA-256 of the image (deterministic compilation: same sources, same hash).</summary>
    public required string Hash { get; set; }
    /// <summary>JSON: the compiled files [{ path, content }].</summary>
    public required string Sources { get; set; }
    /// <summary>JSON: the library versions [{ key, version }].</summary>
    public string Libraries { get; set; } = "[]";
    public bool IsActive { get; set; }
    public DateTime CreatedAt { get; set; }
    public Guid? CreatedBy { get; set; }
}

/// <summary>Shared code (helpers) apps can use; versioned, an app uses a fixed version.</summary>
public class CodeLibrary : Entity, IAudited
{
    public required string Key { get; set; }
    public required string Name { get; set; }
    public string? Description { get; set; }
}

public class CodeLibraryFile : Entity
{
    public Guid LibraryId { get; set; }
    public required string Path { get; set; }
    public required string Content { get; set; }
    public DateTime UpdatedAt { get; set; }
    public Guid? UpdatedBy { get; set; }
}

/// <summary>A published (immutable) version of a library: its sources and compiled image.</summary>
public class CodeLibraryVersion : Entity
{
    public Guid LibraryId { get; set; }
    public required string Version { get; set; }
    public required string Sources { get; set; }
    public required byte[] Image { get; set; }
    public required string Hash { get; set; }
    public DateTime CreatedAt { get; set; }
    public Guid? CreatedBy { get; set; }
}

/// <summary>The app definition being designed (Development). Publishing installs it as a new version.</summary>
/// <summary>
/// An app's preview: its draft installed under a key of its own (tables app_&lt;key&gt;_pv_…), to try it
/// with real data and code before publishing. The definition is the one the preview tables have.
/// </summary>
public class AppPreview : Entity
{
    public required string AppKey { get; set; }
    public required string Definition { get; set; }
    public DateTime UpdatedAt { get; set; }
    public Guid? UpdatedBy { get; set; }
}

public class AppDraft : Entity
{
    public required string AppKey { get; set; }
    /// <summary>The app definition (JSON), possibly not valid yet.</summary>
    public required string Definition { get; set; }
    public DateTime UpdatedAt { get; set; }
    public Guid? UpdatedBy { get; set; }
}
