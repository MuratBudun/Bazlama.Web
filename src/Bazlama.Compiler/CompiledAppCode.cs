using System.Reflection;
using System.Text.Json;
using Bazlama.Engine;
using Bazlama.Engine.Metadata;
using Bazlama.Kernel;
using Bazlama.Kernel.Auditing;
using Bazlama.Kernel.Data;
using Bazlama.Sdk;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;

namespace Bazlama.Compiler;

/// <summary>Field values (field key → CLR value) ↔ the generated record classes.</summary>
static class RecordMapper
{
    static IEnumerable<(PropertyInfo Property, string Key)> Fields(Type type) =>
        type.GetProperties().Select(p => (p, p.GetCustomAttribute<FieldAttribute>()?.Key)).Where(x => x.Key is not null)!;

    public static Record ToRecord(Type type, Guid id, Guid? parentId, IReadOnlyDictionary<string, object?> values)
    {
        var record = (Record)Activator.CreateInstance(type)!;
        record.Id = id;
        record.ParentId = parentId;
        foreach (var (property, key) in Fields(type))
            if (values.TryGetValue(key, out var value)) property.SetValue(record, value);
        return record;
    }

    public static void CopyBack(Record record, Dictionary<string, object?> values)
    {
        foreach (var (property, key) in Fields(record.GetType()))
            if (values.ContainsKey(key)) values[key] = property.GetValue(record);
    }

    /// <summary>A record the data service read (its dictionary) as the generated class.</summary>
    public static Record FromData(Type type, Dictionary<string, object?> data) =>
        ToRecord(type, (Guid)data["id"]!, data.GetValueOrDefault("parentId") as Guid?, data);
}

/// <summary>The context app code receives (IAppContext of the SDK).</summary>
sealed class CodeContext(IRequestContext request, TimeProvider time, IRecords records, CancellationToken cancellation) : IAppContext
{
    public Guid? UserId => request.UserId;
    public string? UserName => request.UserName;
    public Guid? CompanyId => request.CompanyId;
    public Guid? LocationId => request.LocationId;
    public Guid? PlantId => request.PlantId;
    public Guid? PeriodId => request.PeriodId;
    public DateTime UtcNow => time.GetUtcNow().UtcDateTime;
    public IRecords Records => records;
    public CancellationToken Cancellation => cancellation;
}

/// <summary>Reads for app code: the organization scope applies, the user's permissions do not.</summary>
sealed class CodeRecords(string appKey, LoadedApp loaded, IServiceProvider services, CancellationToken ct) : IRecords
{
    string EntityKey<T>() => typeof(T).GetCustomAttribute<EntityAttribute>()?.Key
        ?? throw new InvalidOperationException($"{typeof(T).Name} bir entity sınıfı değil.");

    public async Task<T?> GetAsync<T>(Guid id) where T : Record, new()
    {
        var (_, data) = await services.GetRequiredService<DataService>().GetAsync(appKey, EntityKey<T>(), id, ct, asSystem: true);
        return data is null ? null : (T)RecordMapper.FromData(loaded.Records[EntityKey<T>()], data);
    }

    public async Task<IReadOnlyList<T>> ListAsync<T>(string? search = null, int take = 100, Guid? parentId = null) where T : Record, new()
    {
        var (result, list) = await services.GetRequiredService<DataService>()
            .ListAsync(appKey, EntityKey<T>(), new ListQuery(search, Take: Math.Clamp(take, 1, 500), ParentId: parentId), ct, asSystem: true);
        if (list is null) throw new InvalidOperationException(string.Join(" ", result.Errors ?? []));
        var type = loaded.Records[EntityKey<T>()];
        return [.. list.Items.Select(i => (T)RecordMapper.FromData(type, i))];
    }
}

/// <summary>Runs an app's entity events around the data service's saves and deletes.</summary>
public sealed class CompiledAppCode(AppCodeHost host, IServiceProvider services, IRequestContext request, TimeProvider time, ILogger<CompiledAppCode> log) : IAppCode
{
    /// <summary>App code gets this long per call. (A busy loop cannot be stopped: the request waits no longer, the thread may.)</summary>
    public static TimeSpan Timeout { get; set; } = TimeSpan.FromSeconds(10);

    public async Task<CodeOutcome> BeforeSaveAsync(AppDefinition app, EntityDefinition entity, Guid id, Guid? parentId, Dictionary<string, object?> values, bool isNew, CancellationToken ct)
    {
        if (Handlers(app, entity) is not { } h) return CodeOutcome.None;
        var record = RecordMapper.ToRecord(h.RecordType, id, parentId, values);
        var errors = new Errors();
        var outcome = await RunAsync(app, h.Loaded, ct, async context =>
        {
            foreach (var handler in h.Instances) await Call(handler, "ValidateAsync", record, isNew, errors, context);
            if (errors.Any) return;
            foreach (var handler in h.Instances) await Call(handler, "BeforeSaveAsync", record, isNew, context);
        });
        if (outcome is not null) return outcome;
        if (errors.Any) return new CodeOutcome(errors.Fields, errors.General);
        RecordMapper.CopyBack(record, values);
        return CodeOutcome.None;
    }

    public async Task<CodeOutcome> AfterSaveAsync(AppDefinition app, EntityDefinition entity, Guid id, Guid? parentId, Dictionary<string, object?> values, bool isNew, CancellationToken ct)
    {
        if (Handlers(app, entity) is not { } h) return CodeOutcome.None;
        var record = RecordMapper.ToRecord(h.RecordType, id, parentId, values);
        return await RunAsync(app, h.Loaded, ct, async context =>
        {
            foreach (var handler in h.Instances) await Call(handler, "AfterSaveAsync", record, isNew, context);
        }) ?? CodeOutcome.None;
    }

    public async Task<CodeOutcome> BeforeDeleteAsync(AppDefinition app, EntityDefinition entity, Guid id, Guid? parentId, Dictionary<string, object?> values, CancellationToken ct)
    {
        if (Handlers(app, entity) is not { } h) return CodeOutcome.None;
        var record = RecordMapper.ToRecord(h.RecordType, id, parentId, values);
        var errors = new Errors();
        var outcome = await RunAsync(app, h.Loaded, ct, async context =>
        {
            foreach (var handler in h.Instances) await Call(handler, "BeforeDeleteAsync", record, errors, context);
        });
        return outcome ?? (errors.Any ? new CodeOutcome(errors.Fields, errors.General) : CodeOutcome.None);
    }

    sealed record HandlerSet(LoadedApp Loaded, Type RecordType, IReadOnlyList<object> Instances);

    HandlerSet? Handlers(AppDefinition app, EntityDefinition entity)
    {
        var loaded = host.Get(app.Key);
        if (loaded is null || !loaded.Events.TryGetValue(entity.Key, out var types) || !loaded.Records.TryGetValue(entity.Key, out var recordType)) return null;
        return new HandlerSet(loaded, recordType, [.. types.Select(t => Activator.CreateInstance(t)!)]);
    }

    /// <summary>Runs app code with a context and a time limit; its failures become a refusal (null = it ran).</summary>
    internal async Task<CodeOutcome?> RunAsync(AppDefinition app, LoadedApp loaded, CancellationToken ct, Func<IAppContext, Task> body)
    {
        using var limit = CancellationTokenSource.CreateLinkedTokenSource(ct);
        limit.CancelAfter(Timeout);
        var context = new CodeContext(request, time, new CodeRecords(app.Key, loaded, services, limit.Token), limit.Token);
        try
        {
            await body(context).WaitAsync(Timeout, ct);
            return null;
        }
        catch (TimeoutException)
        {
            return new CodeOutcome(new Dictionary<string, string>(), [$"Uygulama kodu {Timeout.TotalSeconds:0} saniyede bitmedi."]);
        }
        catch (Exception e) when (e is not OperationCanceledException || !ct.IsCancellationRequested)
        {
            var inner = e is TargetInvocationException { InnerException: { } i } ? i : e;
            log.LogWarning(inner, "App code of {App} (build {Build}) failed", app.Key, loaded.BuildNumber);
            return new CodeOutcome(new Dictionary<string, string>(), [$"Uygulama kodunda hata: {inner.Message}"]);
        }
    }

    static Task Call(object handler, string method, params object[] args) =>
        (Task)handler.GetType().GetMethod(method)!.Invoke(handler, args)!;
}

public sealed record ActionView(string Key, string Label, string? Icon, string? Confirm);
public sealed record ActionOutcome(DataStatus Status, string? Message, IReadOnlyList<string> Errors, IReadOnlyDictionary<string, string>? FieldErrors = null);

/// <summary>Record actions (form buttons) of loaded app code.</summary>
public sealed class ActionRunner(AppCodeHost host, AppRegistry registry, DataService data, IAppCode code, KernelDbContext db, IRequestContext request, TimeProvider time)
{
    public IReadOnlyDictionary<string, IReadOnlyList<ActionView>> ActionsOf(string appKey) =>
        host.Get(appKey)?.Actions.ToDictionary(x => x.Key, x => (IReadOnlyList<ActionView>)[.. x.Value.Select(a => new ActionView(a.Key, a.Label, a.Icon, a.Confirm))])
        ?? new Dictionary<string, IReadOnlyList<ActionView>>();

    public async Task<ActionOutcome> RunAsync(string appKey, string entityKey, Guid id, string actionKey, CancellationToken ct)
    {
        var app = await registry.GetAsync(appKey, ct);
        var entity = app?.Entity(entityKey);
        var loaded = host.Get(appKey);
        var action = loaded?.Actions.GetValueOrDefault(entityKey)?.FirstOrDefault(a => a.Key == actionKey);
        if (app is null || entity is null || loaded is null || action is null) return new(DataStatus.NotFound, null, ["Eylem bulunamadı."]);
        if (!data.CanWrite(app, entity)) return new(DataStatus.Forbidden, null, ["Bu kayıtları değiştirme yetkiniz yok."]);

        var (_, current) = await data.GetAsync(appKey, entityKey, id, ct);
        if (current is null) return new(DataStatus.NotFound, null, ["Kayıt bulunamadı."]);
        var record = RecordMapper.FromData(loaded.Records[entityKey], current);
        Sdk.ActionResult? result = null;
        var failure = await ((CompiledAppCode)code).RunAsync(app, loaded, ct, async context =>
        {
            var instance = Activator.CreateInstance(action.Type)!;
            result = await (Task<Sdk.ActionResult>)action.Type.GetMethod("RunAsync")!.Invoke(instance, [record, context])!;
        });
        if (failure is not null) return new(DataStatus.Invalid, null, failure.Errors);
        if (result!.Errors.Count > 0) return new(DataStatus.Invalid, null, result.Errors);

        if (result.SaveRecord)
        {
            var values = entity.Fields.ToDictionary(f => f.Key, f => current.GetValueOrDefault(f.Key));
            RecordMapper.CopyBack(record, values);
            var saved = await data.UpdateAsync(appKey, entityKey, id, JsonSerializer.SerializeToElement(values), (int)current["rowVersion"]!, ct);
            if (saved.Status != DataStatus.Ok) return new(saved.Status, null, saved.Errors ?? ["Formdaki hataları düzeltin."], saved.FieldErrors);
        }
        db.AuditEvents.Add(new AuditEvent
        {
            At = time.GetUtcNow().UtcDateTime,
            Category = "data",
            Action = $"{appKey}.{entityKey}.action",
            UserId = request.UserId,
            UserName = request.UserName,
            SessionId = request.SessionId,
            IpAddress = request.IpAddress,
            EntityType = $"{appKey}.{entityKey}",
            EntityId = id.ToString(),
            Data = JsonSerializer.Serialize(new { action = actionKey, result.Message, saved = result.SaveRecord }),
        });
        await db.SaveChangesAsync(ct);
        return new(DataStatus.Ok, result.Message, []);
    }
}
