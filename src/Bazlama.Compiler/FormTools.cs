using System.Reflection;
using System.Text.Json;
using Bazlama.Engine;
using Bazlama.Engine.Metadata;
using Bazlama.Sdk;

namespace Bazlama.Compiler;

/// <summary>A modal the code asked for: its key, what it starts with, and (after a refused attempt) what was wrong.</summary>
public sealed record ModalPrompt(string Key, Dictionary<string, object?> Values, IReadOnlyDictionary<string, string>? FieldErrors = null, IReadOnlyList<string>? Errors = null)
{
    /// <summary>Field key → the title of the record a reference field holds.</summary>
    public IReadOnlyDictionary<string, string?>? Titles { get; init; }
}

/// <summary>Whether the user may choose this company, location, plant or period (a modal's organization fields).</summary>
public delegate bool OrganizationCheck(FieldType type, Guid id);

/// <summary>
/// What a form tool did: the form's values after it (to put back on the screen), or a modal to
/// show first (then the tool is called again with what the user entered).
/// </summary>
public sealed record ToolOutcome(
    DataStatus Status,
    Dictionary<string, object?>? Values = null,
    string? Message = null,
    bool Save = false,
    ModalPrompt? Modal = null,
    IReadOnlyList<string>? Errors = null,
    IReadOnlyDictionary<string, string>? FieldErrors = null)
{
    /// <summary>Field key → the title of the record a reference field the tool changed now holds.</summary>
    public IReadOnlyDictionary<string, string?>? Titles { get; init; }
}

/// <summary>Thrown out of app code by <see cref="IModals.ShowAsync{T}"/> when the modal has to be shown first.</summary>
sealed class ModalRequested(ModalPrompt prompt) : Exception($"Modal: {prompt.Key}")
{
    public ModalPrompt Prompt { get; } = prompt;

    /// <summary>The request inside whatever the call stack wrapped it in.</summary>
    public static ModalRequested? In(Exception? e) => e switch
    {
        ModalRequested m => m,
        TargetInvocationException { InnerException: { } inner } => In(inner),
        AggregateException a => a.InnerExceptions.Select(In).FirstOrDefault(x => x is not null),
        _ => null,
    };
}

/// <summary>No user is waiting for the code (a save, a delete): a modal cannot be shown.</summary>
sealed class NoModals : IModals
{
    public static readonly NoModals Instance = new();
    const string Message = "Modal yalnız bir kullanıcı eylemi sırasında (formun Araçlar menüsü) açılabilir; kaydetme ve silme olaylarında açılamaz.";

    public Task<T> ShowAsync<T>(Action<T>? initial = null) where T : ModalValues, new() => throw new InvalidOperationException(Message);
    public Task<IReadOnlyDictionary<string, object?>> ShowAsync(string modal, IReadOnlyDictionary<string, object?>? initial = null) => throw new InvalidOperationException(Message);
}

/// <summary>
/// Modals during a form tool. A modal the request carries no input for ends the run with a
/// <see cref="ModalRequested"/>; with input, the values are checked (required fields, the modal's
/// code) and returned, or the modal is asked for again with the errors.
/// </summary>
sealed class InteractiveModals(AppDefinition app, LoadedApp loaded, IReadOnlyDictionary<string, JsonElement> inputs, OrganizationCheck? organization, IAppContext context) : IModals
{
    public async Task<T> ShowAsync<T>(Action<T>? initial = null) where T : ModalValues, new()
    {
        var key = typeof(T).GetCustomAttribute<ModalAttribute>()?.Key ?? throw new InvalidOperationException($"{typeof(T).Name} bir modal sınıfı değil.");
        return (T)await ShowAsync(key, typeof(T), values => initial?.Invoke((T)values));
    }

    public async Task<IReadOnlyDictionary<string, object?>> ShowAsync(string modal, IReadOnlyDictionary<string, object?>? initial = null)
    {
        if (!loaded.Modals.TryGetValue(modal, out var type)) throw new InvalidOperationException($"Modal bulunamadı: '{modal}'.");
        var values = await ShowAsync(modal, type, v =>
        {
            if (initial is not null) ValueMapper.Fill(v, initial);
        });
        return ValueMapper.Read(values);
    }

    async Task<ModalValues> ShowAsync(string key, Type type, Action<ModalValues> initial)
    {
        var definition = app.Modal(key) ?? throw new InvalidOperationException($"Modal bulunamadı: '{key}'.");
        var values = (ModalValues)Activator.CreateInstance(type)!;
        var code = loaded.ModalCode.GetValueOrDefault(key) ?? [];

        if (!inputs.TryGetValue(key, out var input))
        {
            initial(values);
            foreach (var c in code) await Call(c, nameof(ModalCode<ModalValues>.OpenAsync), values, context);
            throw new ModalRequested(new ModalPrompt(key, ValueMapper.Read(values)));
        }

        var (parsed, fieldErrors) = DataService.ParseFields(definition.Fields, input);
        foreach (var f in definition.Fields.Where(f => f.Required && !fieldErrors.ContainsKey(f.Key) && parsed.GetValueOrDefault(f.Key) is null))
            fieldErrors[f.Key] = "Zorunlu alan.";
        // What the user sends is checked again: only what they may work in.
        if (organization is not null)
            foreach (var f in definition.Fields.Where(f => MetadataValidator.IsOrganization(f.Type) && parsed.GetValueOrDefault(f.Key) is Guid id && !organization(f.Type, id)))
                fieldErrors[f.Key] = "Bu seçime yetkiniz yok.";
        var general = new List<string>();
        if (fieldErrors.Count == 0)
        {
            ValueMapper.Fill(values, parsed);
            var errors = new Errors();
            foreach (var c in code) await Call(c, nameof(ModalCode<ModalValues>.ValidateAsync), values, errors, context);
            foreach (var (field, message) in errors.Fields) fieldErrors[field] = message;
            general.AddRange(errors.General);
            if (!errors.Any) return values;
            parsed = ValueMapper.Read(values);
        }
        throw new ModalRequested(new ModalPrompt(key, parsed, fieldErrors, general));
    }

    static Task Call(Type code, string method, params object[] args) =>
        (Task)code.GetMethod(method)!.Invoke(Activator.CreateInstance(code), args)!;
}

/// <summary>Runs the tools of a form's menu: methods of the form's code class, on the form as it is on the screen.</summary>
public sealed class FormToolRunner(AppCodeHost host, AppRegistry registry, DataService data, IAppCode code)
{
    public async Task<ToolOutcome> RunAsync(string appKey, string formKey, string method, Guid? id, Guid? parentId, JsonElement values, IReadOnlyDictionary<string, JsonElement>? inputs, OrganizationCheck? organization, CancellationToken ct)
    {
        var app = await registry.GetAsync(appKey, ct);
        var form = app?.Form(formKey);
        var entity = form is null ? null : app!.Entity(form.Entity);
        // Only what the form's menu offers can be called.
        var tool = form?.Tools.FirstOrDefault(t => t.Method == method);
        if (app is null || form is null || entity is null || tool is null) return new(DataStatus.NotFound, Errors: ["Araç bulunamadı."]);
        if (!data.CanRead(app, entity)) return new(DataStatus.Forbidden, Errors: ["Bu kayıtları görme yetkiniz yok."]);

        var loaded = host.Get(appKey);
        if (loaded is null) return new(DataStatus.Invalid, Errors: ["Uygulamanın kodu yüklü değil: Geliştirme'de derleyin."]);
        if (!loaded.Forms.TryGetValue(formKey, out var formCode))
            return new(DataStatus.Invalid, Errors: [$"Formun kodu yok: [Form(\"{formKey}\")] ile işaretli bir FormCode<{EntityCodeGenerator.ClassName(entity)}> sınıfı gerekli."]);
        var target = FormCodeInfo.Tool(formCode.Type, method, formCode.RecordType);
        if (target is null)
            return new(DataStatus.Invalid, Errors: [$"{formCode.Type.Name}.{method}({formCode.RecordType.Name} record, IAppContext context) metodu bulunamadı."]);

        var (fields, fieldErrors) = DataService.ParseFields(entity.Fields, values);
        if (fieldErrors.Count > 0) return new(DataStatus.Invalid, Errors: ["Formdaki hataları düzeltin."], FieldErrors: fieldErrors);
        var record = ValueMapper.ToRecord(formCode.RecordType, id ?? Guid.Empty, parentId, fields);

        Sdk.ActionResult? result = null;
        ModalPrompt? prompt = null;
        var failure = await ((CompiledAppCode)code).RunAsync(app, loaded, ct,
            async context =>
            {
                try
                {
                    var returned = target.Invoke(Activator.CreateInstance(formCode.Type), [record, context]);
                    if (returned is Task task)
                    {
                        await task;
                        // Task<ActionResult> has a Result; a plain Task's is nothing to return.
                        returned = task.GetType().GetProperty("Result")?.GetValue(task);
                    }
                    result = returned as Sdk.ActionResult ?? Sdk.ActionResult.Ok();
                }
                catch (Exception e) when (ModalRequested.In(e) is { } asked)
                {
                    prompt = asked.Prompt;
                }
            },
            context => new InteractiveModals(app, loaded, inputs ?? new Dictionary<string, JsonElement>(), organization, context));

        if (failure is not null) return new(DataStatus.Invalid, Errors: failure.Errors);
        if (prompt is not null)
            return new(DataStatus.Ok, Modal: prompt with { Titles = await TitlesAsync(app, app.Modal(prompt.Key)!.Fields, prompt.Values, null, ct) });
        if (result!.Errors.Count > 0) return new(DataStatus.Invalid, Errors: result.Errors);
        var before = new Dictionary<string, object?>(fields);
        ValueMapper.CopyBack(record, fields);
        return new(DataStatus.Ok, Values: fields, Message: result.Message, Save: result.SaveRecord) { Titles = await TitlesAsync(app, entity.Fields, fields, before, ct) };
    }

    /// <summary>The titles of the records the reference fields hold (only the changed ones when <paramref name="before"/> is given).</summary>
    async Task<IReadOnlyDictionary<string, string?>> TitlesAsync(AppDefinition app, IReadOnlyList<FieldDefinition> fields, Dictionary<string, object?> values, Dictionary<string, object?>? before, CancellationToken ct)
    {
        var titles = new Dictionary<string, string?>();
        foreach (var f in fields.Where(f => f.Type == FieldType.Reference))
        {
            if (values.GetValueOrDefault(f.Key) is not Guid id || (before is not null && Equals(before.GetValueOrDefault(f.Key), id))) continue;
            var target = app.Entity(f.Reference!)!;
            var (_, found) = await data.GetAsync(app.Key, target.Key, id, ct);
            titles[f.Key] = found is not null && target.EffectiveTitleField() is { } title ? Convert.ToString(found.GetValueOrDefault(title), System.Globalization.CultureInfo.InvariantCulture) : null;
        }
        return titles;
    }
}

/// <summary>A form's code class and the record class its tools take.</summary>
public sealed record FormCodeInfo(Type Type, Type RecordType)
{
    /// <summary>The public method a tool calls: (record, IAppContext).</summary>
    public static MethodInfo? Tool(Type type, string name, Type recordType) =>
        type.GetMethods(BindingFlags.Public | BindingFlags.Instance)
            .FirstOrDefault(m => m.Name == name && m.GetParameters() is [var record, var context]
                && record.ParameterType.IsAssignableFrom(recordType) && context.ParameterType == typeof(IAppContext));
}
