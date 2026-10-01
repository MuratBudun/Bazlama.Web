namespace Bazlama.Sdk;

/// <summary>Marks a generated entity class with the entity key of the app metadata.</summary>
[AttributeUsage(AttributeTargets.Class)]
public sealed class EntityAttribute(string key) : Attribute
{
    /// <summary>The entity key in the app metadata.</summary>
    public string Key { get; } = key;
}

/// <summary>Marks a generated property with the field key of the app metadata.</summary>
[AttributeUsage(AttributeTargets.Property)]
public sealed class FieldAttribute(string key) : Attribute
{
    /// <summary>The field key in the app metadata.</summary>
    public string Key { get; } = key;
}

/// <summary>Base of the generated entity classes (one per entity of the app).</summary>
public abstract class Record
{
    /// <summary>The record's id.</summary>
    public Guid Id { get; set; }

    /// <summary>The master record of a detail record; null for masters.</summary>
    public Guid? ParentId { get; set; }
}

/// <summary>Who is acting, in which organization context, and access to other records.</summary>
public interface IAppContext
{
    /// <summary>The signed-in user.</summary>
    Guid? UserId { get; }

    /// <summary>The signed-in user's name.</summary>
    string? UserName { get; }

    /// <summary>The active company.</summary>
    Guid? CompanyId { get; }

    /// <summary>The active location.</summary>
    Guid? LocationId { get; }

    /// <summary>The active plant (if any).</summary>
    Guid? PlantId { get; }

    /// <summary>The active period (if any).</summary>
    Guid? PeriodId { get; }

    /// <summary>Now, in UTC.</summary>
    DateTime UtcNow { get; }

    /// <summary>Reads records of this app (limited to the organization context).</summary>
    IRecords Records { get; }

    /// <summary>Cancelled when the request ends or the code runs too long.</summary>
    CancellationToken Cancellation { get; }
}

/// <summary>Reads records of the app. Results are limited to the active organization context.</summary>
public interface IRecords
{
    /// <summary>One record, or null.</summary>
    Task<T?> GetAsync<T>(Guid id) where T : Record, new();

    /// <summary>Records, optionally searched (text fields) or limited to a master's details.</summary>
    Task<IReadOnlyList<T>> ListAsync<T>(string? search = null, int take = 100, Guid? parentId = null) where T : Record, new();
}

/// <summary>Validation errors: for a field (shown under it) or for the record.</summary>
public sealed class Errors
{
    readonly Dictionary<string, string> fields = [];
    readonly List<string> general = [];

    /// <summary>An error for a field (its key in the metadata).</summary>
    public void Add(string field, string message) => fields.TryAdd(field, message);

    /// <summary>An error for the whole record.</summary>
    public void Add(string message) => general.Add(message);

    /// <summary>Whether any error was added.</summary>
    public bool Any => fields.Count > 0 || general.Count > 0;

    /// <summary>Field errors by field key.</summary>
    public IReadOnlyDictionary<string, string> Fields => fields;

    /// <summary>Record errors.</summary>
    public IReadOnlyList<string> General => general;
}

/// <summary>
/// Business logic of an entity: derive from it (one class per entity) and override what you need.
/// Saves call ValidateAsync, then BeforeSaveAsync (may change the record), write, then AfterSaveAsync
/// (in the same transaction: an exception undoes the save).
/// </summary>
public abstract class EntityEvents<T> where T : Record
{
    /// <summary>Checks the record; add to <paramref name="errors"/> to refuse the save.</summary>
    public virtual Task ValidateAsync(T record, bool isNew, Errors errors, IAppContext context) => Task.CompletedTask;

    /// <summary>Last changes before the record is written (computed fields, defaults).</summary>
    public virtual Task BeforeSaveAsync(T record, bool isNew, IAppContext context) => Task.CompletedTask;

    /// <summary>After the record is written.</summary>
    public virtual Task AfterSaveAsync(T record, bool isNew, IAppContext context) => Task.CompletedTask;

    /// <summary>Before the record is deleted; add to <paramref name="errors"/> to refuse it.</summary>
    public virtual Task BeforeDeleteAsync(T record, Errors errors, IAppContext context) => Task.CompletedTask;
}

/// <summary>A button on a record's form. Name the class (the action key) and describe it with <see cref="ActionAttribute"/>.</summary>
public abstract class RecordAction<T> where T : Record
{
    /// <summary>Runs on the record. Change it and return <see cref="ActionResult.Save"/> to store the changes.</summary>
    public abstract Task<ActionResult> RunAsync(T record, IAppContext context);
}

/// <summary>How a record action looks on the form.</summary>
[AttributeUsage(AttributeTargets.Class)]
public sealed class ActionAttribute(string label) : Attribute
{
    /// <summary>The button text.</summary>
    public string Label { get; } = label;

    /// <summary>An icon name.</summary>
    public string? Icon { get; init; }

    /// <summary>A question asked before running ("Sipariş onaylansın mı?").</summary>
    public string? Confirm { get; init; }
}

/// <summary>The outcome of a record action.</summary>
public sealed record ActionResult(string? Message, bool SaveRecord, IReadOnlyList<string> Errors)
{
    /// <summary>Done; nothing to store.</summary>
    public static ActionResult Ok(string? message = null) => new(message, false, []);

    /// <summary>Done; store the changed record (validation and save events run).</summary>
    public static ActionResult Save(string? message = null) => new(message, true, []);

    /// <summary>Refused, with the reason for the user.</summary>
    public static ActionResult Fail(params string[] errors) => new(null, false, errors);
}
