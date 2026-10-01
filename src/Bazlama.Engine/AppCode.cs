using Bazlama.Engine.Metadata;

namespace Bazlama.Engine;

/// <summary>What app code said about a save or delete. Empty = go ahead.</summary>
public sealed record CodeOutcome(IReadOnlyDictionary<string, string> FieldErrors, IReadOnlyList<string> Errors)
{
    public static readonly CodeOutcome None = new(new Dictionary<string, string>(), []);
    public bool Refused => FieldErrors.Count > 0 || Errors.Count > 0;
}

/// <summary>
/// The app's compiled code, as the data service sees it: the entity events around saves and
/// deletes. <paramref name="values"/> holds the field values (field key → CLR value); BeforeSave
/// may change them.
/// </summary>
public interface IAppCode
{
    Task<CodeOutcome> BeforeSaveAsync(AppDefinition app, EntityDefinition entity, Guid id, Guid? parentId, Dictionary<string, object?> values, bool isNew, CancellationToken ct);
    /// <summary>Runs inside the save's transaction: refusing (or failing) undoes the save.</summary>
    Task<CodeOutcome> AfterSaveAsync(AppDefinition app, EntityDefinition entity, Guid id, Guid? parentId, Dictionary<string, object?> values, bool isNew, CancellationToken ct);
    Task<CodeOutcome> BeforeDeleteAsync(AppDefinition app, EntityDefinition entity, Guid id, Guid? parentId, Dictionary<string, object?> values, CancellationToken ct);
}

/// <summary>Apps without code.</summary>
public sealed class NoAppCode : IAppCode
{
    public Task<CodeOutcome> BeforeSaveAsync(AppDefinition app, EntityDefinition entity, Guid id, Guid? parentId, Dictionary<string, object?> values, bool isNew, CancellationToken ct) => Task.FromResult(CodeOutcome.None);
    public Task<CodeOutcome> AfterSaveAsync(AppDefinition app, EntityDefinition entity, Guid id, Guid? parentId, Dictionary<string, object?> values, bool isNew, CancellationToken ct) => Task.FromResult(CodeOutcome.None);
    public Task<CodeOutcome> BeforeDeleteAsync(AppDefinition app, EntityDefinition entity, Guid id, Guid? parentId, Dictionary<string, object?> values, CancellationToken ct) => Task.FromResult(CodeOutcome.None);
}
