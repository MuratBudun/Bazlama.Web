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

    /// <summary>Opens the app's modals (asks the user for input) while a user is waiting for the code.</summary>
    IModals Modals { get; }

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

// ── Forms and modals ────────────────────────────────────────────────────────

/// <summary>Marks a class as the code of a form: <c>[Form("siparis")] class SiparisFormu : FormCode&lt;Siparis&gt;</c>.</summary>
[AttributeUsage(AttributeTargets.Class)]
public sealed class FormAttribute(string key) : Attribute
{
    /// <summary>The form key in the app metadata.</summary>
    public string Key { get; } = key;
}

/// <summary>
/// The code of a form. Its public methods are what the form's tools menu ("Araçlar") calls:
/// <code>
/// public async Task&lt;ActionResult&gt; TeslimHesapla(Siparis record, IAppContext context)
/// </code>
/// The record is the form as it is on the screen, saved or not (a new record has an empty Id).
/// What the method changes goes back to the form; nothing is stored unless it returns
/// <see cref="ActionResult.Save"/> (then the form is saved the usual way). A method may also
/// return Task, ActionResult or nothing.
/// </summary>
public abstract class FormCode<T> where T : Record
{
}

/// <summary>Marks a generated modal class with the modal key of the app metadata.</summary>
[AttributeUsage(AttributeTargets.Class)]
public sealed class ModalAttribute(string key) : Attribute
{
    /// <summary>The modal key in the app metadata.</summary>
    public string Key { get; } = key;
}

/// <summary>Base of the generated modal classes (one per modal of the app): what the user entered.</summary>
public abstract class ModalValues
{
}

/// <summary>The code of a modal: derive from it (one class per modal) and override what you need.</summary>
public abstract class ModalCode<T> where T : ModalValues
{
    /// <summary>Before the modal is shown: fill in what it starts with.</summary>
    public virtual Task OpenAsync(T values, IAppContext context) => Task.CompletedTask;

    /// <summary>When the user accepts it; add to <paramref name="errors"/> to keep it open.</summary>
    public virtual Task ValidateAsync(T values, Errors errors, IAppContext context) => Task.CompletedTask;
}

/// <summary>
/// Opens a modal of the app and gives back what the user entered. Works while a user is waiting
/// for the code (a form's tool); elsewhere (saves, deletes) it throws.
/// <para>
/// The code does not really wait: the first call ends the run, the modal is shown, and when the
/// user accepts it the method runs again from the start, this time getting the values. So the
/// code before the call runs twice: keep it free of side effects (it normally only reads).
/// If the user cancels, the method is not run again.
/// </para>
/// </summary>
public interface IModals
{
    /// <summary>Opens the modal of the generated class <typeparamref name="T"/>; <paramref name="initial"/> sets what it starts with.</summary>
    Task<T> ShowAsync<T>(Action<T>? initial = null) where T : ModalValues, new();

    /// <summary>Opens a modal by its key (for code that does not know the app's classes, e.g. a code library). Values by field key.</summary>
    Task<IReadOnlyDictionary<string, object?>> ShowAsync(string modal, IReadOnlyDictionary<string, object?>? initial = null);
}
