using System.Text.Json;
using Bazlama.Engine;
using Bazlama.Engine.Metadata;
using Bazlama.Modules.Identity;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Routing;

namespace Bazlama.Modules.Runtime;

public sealed record RuntimeEntity(string Key, string Name, string Plural, string? Icon);
public sealed record RuntimeApp(string Key, string Name, string Version, string? Description, string? Icon, IReadOnlyList<RuntimeEntity> Entities);
public sealed record EntityAccess(bool CanRead, bool CanWrite);
public sealed record CreateRequest(JsonElement Values, Guid? ParentId);
public sealed record UpdateRequest(JsonElement Values, int RowVersion);

/// <summary>/api/runtime: the installed apps a user may use, and their records.</summary>
public static class RuntimeModule
{
    public static IEndpointRouteBuilder MapRuntimeEndpoints(this IEndpointRouteBuilder endpoints)
    {
        var api = endpoints.MapGroup("/api/runtime").RequireActiveSession();

        // Apps with at least one master entity the user may read.
        api.MapGet("/apps", async (AppRegistry registry, DataService data, CancellationToken ct) =>
            (await registry.AllAsync(ct)).Values
                .Select(app => new RuntimeApp(app.Key, app.Name, app.Version, app.Description, app.Icon,
                    [.. app.Entities.Where(e => e.Parent is null && data.CanRead(app, e)).Select(e => new RuntimeEntity(e.Key, e.Name, e.DisplayPlural, e.Icon))]))
                .Where(a => a.Entities.Count > 0)
                .OrderBy(a => a.Name));

        // The definition the UI renders, with what the user may do per entity.
        api.MapGet("/apps/{app}", async (string app, AppRegistry registry, DataService data, CancellationToken ct) =>
        {
            var def = await registry.GetAsync(app, ct);
            if (def is null || !def.Entities.Any(e => data.CanRead(def, e))) return Results.NotFound();
            var access = def.Entities.ToDictionary(e => e.Key, e => new EntityAccess(data.CanRead(def, e), data.CanWrite(def, e)));
            return Results.Ok(new { definition = JsonSerializer.SerializeToElement(def, AppDefinition.Json), access });
        });

        var records = api.MapGroup("/data/{app}/{entity}");

        records.MapGet("/", async (string app, string entity, string? q, string? sort, bool? desc, int? skip, int? take, Guid? parent, DataService data, CancellationToken ct) =>
        {
            var (result, list) = await data.ListAsync(app, entity, new ListQuery(q, sort, desc ?? false, skip ?? 0, take ?? 50, parent), ct);
            return list is null ? Fail(result) : Results.Ok(list);
        });

        records.MapGet("/{id:guid}", async (string app, string entity, Guid id, DataService data, CancellationToken ct) =>
        {
            var (result, record) = await data.GetAsync(app, entity, id, ct);
            return record is null ? Fail(result) : Results.Ok(record);
        });

        records.MapPost("/", async (string app, string entity, CreateRequest r, DataService data, CancellationToken ct) =>
            Respond(await data.CreateAsync(app, entity, r.Values, r.ParentId, ct)));

        records.MapPut("/{id:guid}", async (string app, string entity, Guid id, UpdateRequest r, DataService data, CancellationToken ct) =>
            Respond(await data.UpdateAsync(app, entity, id, r.Values, r.RowVersion, ct)));

        records.MapDelete("/{id:guid}", async (string app, string entity, Guid id, DataService data, CancellationToken ct) =>
            Respond(await data.DeleteAsync(app, entity, id, ct)));

        return endpoints;
    }

    static IResult Respond(DataResult r) => r.Status == DataStatus.Ok ? Results.Ok(new { id = r.Id }) : Fail(r);

    /// <summary>{ errors: [...], fieldErrors: { field: message } } with the matching status code.</summary>
    static IResult Fail(DataResult r) => Results.Json(
        new { errors = r.Errors ?? (r.FieldErrors is { Count: > 0 } ? ["Formdaki hataları düzeltin."] : []), fieldErrors = r.FieldErrors },
        statusCode: r.Status switch
        {
            DataStatus.NotFound => StatusCodes.Status404NotFound,
            DataStatus.Forbidden => StatusCodes.Status403Forbidden,
            DataStatus.Conflict => StatusCodes.Status409Conflict,
            _ => StatusCodes.Status400BadRequest,
        });
}
