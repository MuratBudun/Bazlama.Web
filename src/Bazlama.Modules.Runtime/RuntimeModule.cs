using System.Text.Json;
using Bazlama.Compiler;
using Bazlama.Engine;
using Bazlama.Engine.Metadata;
using Bazlama.Kernel.Identity;
using Bazlama.Modules.Identity;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Routing;

namespace Bazlama.Modules.Runtime;

public sealed record RuntimeEntity(string Key, string Name, string Plural, string? Icon);
/// <summary>A menu entry the user may open: a group, a list or a new record's form (with the entity behind it).</summary>
public sealed record RuntimeMenuItem(string Label, string? Icon, string? Entity, string? List, string? Form, IReadOnlyList<RuntimeMenuItem>? Items);
public sealed record RuntimeApp(string Key, string Name, string Version, string? Description, string? Icon, IReadOnlyList<RuntimeEntity> Entities, IReadOnlyList<RuntimeMenuItem> Menu);
public sealed record EntityAccess(bool CanRead, bool CanWrite);
public sealed record CreateRequest(JsonElement Values, Guid? ParentId);
public sealed record UpdateRequest(JsonElement Values, int RowVersion);
/// <summary>A form tool's call: the form as it is on the screen, and what the user entered in the modals it asked for (by modal key).</summary>
public sealed record ToolRequest(JsonElement Values, Guid? Id, Guid? ParentId, Dictionary<string, JsonElement>? Inputs);

/// <summary>/api/runtime: the installed apps a user may use, and their records.</summary>
public static class RuntimeModule
{
    public static IEndpointRouteBuilder MapRuntimeEndpoints(this IEndpointRouteBuilder endpoints)
    {
        var api = endpoints.MapGroup("/api/runtime").RequireActiveSession();

        // Apps with something in their menu the user may open.
        api.MapGet("/apps", async (AppRegistry registry, DataService data, CancellationToken ct) =>
            (await registry.AllAsync(ct)).Values
                .Select(app => new RuntimeApp(app.Key, app.Name, app.Version, app.Description, app.Icon,
                    [.. app.Entities.Where(e => e.Parent is null && data.CanRead(app, e)).Select(e => new RuntimeEntity(e.Key, e.Name, e.DisplayPlural, e.Icon))],
                    MenuOf(app, data)))
                .Where(a => a.Menu.Count > 0)
                .OrderBy(a => a.Name));

        // The definition the UI renders, with what the user may do per entity.
        api.MapGet("/apps/{app}", async (string app, AppRegistry registry, DataService data, ActionRunner actions, CancellationToken ct) =>
        {
            var def = await registry.GetAsync(app, ct);
            if (def is null || !def.Entities.Any(e => data.CanRead(def, e))) return Results.NotFound();
            var access = def.Entities.ToDictionary(e => e.Key, e => new EntityAccess(data.CanRead(def, e), data.CanWrite(def, e)));
            return Results.Ok(new { definition = JsonSerializer.SerializeToElement(def, AppDefinition.Json), access, actions = actions.ActionsOf(app) });
        });

        // A draft's preview (its developers only): what /apps/{app} gives, plus its menu.
        api.MapGet("/previews/{key}", async (string key, AppRegistry registry, DataService data, ActionRunner actions, CancellationToken ct) =>
        {
            var def = await registry.GetAsync(key, ct);
            if (def?.PreviewOf is null) return Results.NotFound();
            var access = def.Entities.ToDictionary(e => e.Key, e => new EntityAccess(data.CanRead(def, e), data.CanWrite(def, e)));
            return Results.Ok(new
            {
                definition = JsonSerializer.SerializeToElement(def, AppDefinition.Json),
                access,
                actions = actions.ActionsOf(key),
                menu = MenuOf(def, data),
                source = def.PreviewOf,
            });
        }).RequirePermission(Permissions.Development);

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

        // A button of the app code on the record's form.
        records.MapPost("/{id:guid}/actions/{action}", async (string app, string entity, Guid id, string action, ActionRunner runner, CancellationToken ct) =>
        {
            var r = await runner.RunAsync(app, entity, id, action, ct);
            return r.Status == DataStatus.Ok
                ? Results.Ok(new { message = r.Message })
                : Fail(new DataResult(r.Status, FieldErrors: r.FieldErrors, Errors: r.Errors));
        });

        // An item of a form's tools menu: a method of the form's code, on the form as it is on the
        // screen. The answer is the form's new values, or a modal to show first (then the same
        // call is made again with the modal's values among the inputs).
        api.MapPost("/forms/{app}/{form}/tools/{method}", async (string app, string form, string method, ToolRequest r, FormToolRunner runner, CurrentSession current, OrgContextService org, CancellationToken ct) =>
        {
            // The user's organization options are read only when a modal's values came along.
            OrganizationCheck? check = null;
            if (r.Inputs is { Count: > 0 } && current.UserId is { } user)
            {
                var options = await org.OptionsAsync(user, ct);
                check = (type, id) => type switch
                {
                    FieldType.Company => options.Any(c => c.Id == id),
                    FieldType.Location => options.Any(c => c.Locations.Any(l => l.Id == id)),
                    FieldType.Plant => options.Any(c => c.Locations.Any(l => l.Plants.Any(p => p.Id == id))),
                    FieldType.Period => options.Any(c => c.Periods.Any(p => p.Id == id)),
                    _ => true,
                };
            }
            var o = await runner.RunAsync(app, form, method, r.Id, r.ParentId, r.Values, r.Inputs, check, ct);
            return o.Status == DataStatus.Ok
                ? Results.Ok(new { values = o.Values, titles = o.Titles, message = o.Message, save = o.Save, modal = o.Modal })
                : Fail(new DataResult(o.Status, FieldErrors: o.FieldErrors, Errors: o.Errors));
        });

        return endpoints;
    }

    /// <summary>
    /// The app's menu as far as the user may read the entities behind it (empty groups go). An app
    /// without a menu gets one item per master entity, opening its first list.
    /// </summary>
    public static IReadOnlyList<RuntimeMenuItem> MenuOf(AppDefinition app, DataService data)
    {
        if (app.Menu.Count == 0)
            return [.. app.Entities.Where(e => e.Parent is null && data.CanRead(app, e))
                .Select(e => new RuntimeMenuItem(e.DisplayPlural, e.Icon, e.Key, app.DefaultList(e)?.Key, null, null))];
        List<RuntimeMenuItem> Visible(IReadOnlyList<MenuItem> items)
        {
            var result = new List<RuntimeMenuItem>();
            foreach (var item in items)
            {
                if (item.Items is { } children)
                {
                    var inner = Visible(children);
                    if (inner.Count > 0) result.Add(new RuntimeMenuItem(item.Label, item.Icon, null, null, null, inner));
                    continue;
                }
                var entityKey = item.List is { } l ? app.List(l)?.Entity : item.Form is { } f ? app.Form(f)?.Entity : null;
                if (entityKey is null || app.Entity(entityKey) is not { } entity || !data.CanRead(app, entity)) continue;
                result.Add(new RuntimeMenuItem(item.Label, item.Icon, entityKey, item.List, item.Form, null));
            }
            return result;
        }
        return Visible(app.Menu);
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
