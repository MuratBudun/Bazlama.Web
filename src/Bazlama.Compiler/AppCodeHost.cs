using System.Collections.Concurrent;
using System.Reflection;
using System.Runtime.Loader;
using Bazlama.Sdk;

namespace Bazlama.Compiler;

public sealed record ActionInfo(string Key, string Label, string? Icon, string? Confirm, Type Type);

/// <summary>An app's compiled code, loaded in its own collectible load context.</summary>
public sealed class LoadedApp
{
    public required string AppKey { get; init; }
    public required int BuildNumber { get; init; }
    public required string Hash { get; init; }
    public required string AppVersion { get; init; }
    internal AppLoadContext Context { get; init; } = null!;

    /// <summary>Entity key → generated record class.</summary>
    public required IReadOnlyDictionary<string, Type> Records { get; init; }
    /// <summary>Entity key → EntityEvents&lt;T&gt; implementations.</summary>
    public required IReadOnlyDictionary<string, IReadOnlyList<Type>> Events { get; init; }
    /// <summary>Entity key → RecordAction&lt;T&gt; implementations.</summary>
    public required IReadOnlyDictionary<string, IReadOnlyList<ActionInfo>> Actions { get; init; }
}

/// <summary>
/// Loads app code (and the code libraries it uses) into a collectible AssemblyLoadContext per app.
/// A new build replaces the old one without a restart: requests take the new one, the old context
/// unloads when nothing uses it any more. Bazlama.Sdk and the BCL come from the host.
/// </summary>
public sealed class AppCodeHost
{
    readonly ConcurrentDictionary<string, LoadedApp> apps = new();

    public LoadedApp? Get(string appKey) => apps.GetValueOrDefault(appKey);

    public LoadedApp Load(string appKey, int buildNumber, string appVersion, byte[] image, string hash, IReadOnlyList<byte[]> libraries)
    {
        var context = new AppLoadContext($"app:{appKey}:{buildNumber}");
        foreach (var lib in libraries) context.AddLibrary(lib);
        var assembly = context.LoadFromStream(new MemoryStream(image));

        var records = new Dictionary<string, Type>();
        var events = new Dictionary<string, List<Type>>();
        var actions = new Dictionary<string, List<ActionInfo>>();
        foreach (var type in assembly.GetTypes())
        {
            if (type.GetCustomAttribute<EntityAttribute>() is { } entity && type.IsSubclassOf(typeof(Record))) records[entity.Key] = type;
            if (type.IsAbstract || type.IsGenericTypeDefinition) continue;
            if (GenericBase(type, typeof(EntityEvents<>)) is { } e && EntityKey(e) is { } ek)
                (events.TryGetValue(ek, out var l) ? l : events[ek] = []).Add(type);
            if (GenericBase(type, typeof(RecordAction<>)) is { } a && EntityKey(a) is { } ak)
            {
                var attr = type.GetCustomAttribute<ActionAttribute>();
                (actions.TryGetValue(ak, out var l) ? l : actions[ak] = []).Add(new ActionInfo(type.Name, attr?.Label ?? type.Name, attr?.Icon, attr?.Confirm, type));
            }
        }

        var loaded = new LoadedApp
        {
            AppKey = appKey,
            BuildNumber = buildNumber,
            Hash = hash,
            AppVersion = appVersion,
            Context = context,
            Records = records,
            Events = events.ToDictionary(x => x.Key, x => (IReadOnlyList<Type>)x.Value),
            Actions = actions.ToDictionary(x => x.Key, x => (IReadOnlyList<ActionInfo>)[.. x.Value.OrderBy(a => a.Label)]),
        };
        if (apps.TryGetValue(appKey, out var old)) old.Context.Unload();
        apps[appKey] = loaded;
        return loaded;
    }

    public void Unload(string appKey)
    {
        if (apps.TryRemove(appKey, out var old)) old.Context.Unload();
    }

    /// <summary>The T of EntityEvents&lt;T&gt; / RecordAction&lt;T&gt; in a type's bases.</summary>
    static Type? GenericBase(Type type, Type open)
    {
        for (var t = type.BaseType; t is not null; t = t.BaseType)
            if (t.IsGenericType && t.GetGenericTypeDefinition() == open) return t.GetGenericArguments()[0];
        return null;
    }

    static string? EntityKey(Type record) => record.GetCustomAttribute<EntityAttribute>()?.Key;
}

/// <summary>One app's code and its libraries; everything else (Bazlama.Sdk, the BCL) resolves from the host.</summary>
sealed class AppLoadContext(string name) : AssemblyLoadContext(name, isCollectible: true)
{
    readonly Dictionary<string, Assembly> libraries = [];

    public void AddLibrary(byte[] image)
    {
        var assembly = LoadFromStream(new MemoryStream(image));
        libraries[assembly.GetName().Name!] = assembly;
    }

    protected override Assembly? Load(AssemblyName name) => libraries.GetValueOrDefault(name.Name!);
}
