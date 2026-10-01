using System.Data.Common;
using System.Globalization;
using System.Text.Json;
using Bazlama.Engine.Metadata;
using Bazlama.Engine.Schema;
using Bazlama.Engine.Sql;
using Bazlama.Kernel;
using Bazlama.Kernel.Auditing;
using Bazlama.Kernel.Data;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Storage;

namespace Bazlama.Engine;

public enum DataStatus { Ok, NotFound, Forbidden, Invalid, Conflict }

/// <summary>An operation's outcome. Errors are for the user (Turkish); field errors are keyed by field.</summary>
public sealed record DataResult(DataStatus Status, Guid? Id = null, IReadOnlyDictionary<string, string>? FieldErrors = null, IReadOnlyList<string>? Errors = null)
{
    public static DataResult Ok(Guid id) => new(DataStatus.Ok, id);
    public static readonly DataResult NotFound = new(DataStatus.NotFound, Errors: ["Kayıt bulunamadı."]);
    public static DataResult Forbidden(string message) => new(DataStatus.Forbidden, Errors: [message]);
    public static DataResult Invalid(params string[] errors) => new(DataStatus.Invalid, Errors: errors);
}

public sealed record ListQuery(string? Search = null, string? Sort = null, bool Descending = false, int Skip = 0, int Take = 50, Guid? ParentId = null);

public sealed record ListResult(IReadOnlyList<Dictionary<string, object?>> Items, int Total);

/// <summary>
/// Reads and writes app records. Every query is limited to the request's organization context
/// (by the entity's scope and period binding) and to the user's permissions; every change is
/// audited. Records are soft-deleted and versioned (row_version) against lost updates.
/// </summary>
public sealed class DataService(KernelDbContext db, SqlDialect d, AppRegistry registry, IRequestContext ctx, TimeProvider time, IAppCode code)
{
    sealed record Target(AppDefinition App, EntityDefinition Entity, EntityDefinition Root, TableSchema Table);

    public static string ReadPermission(AppDefinition app, EntityDefinition root) => $"app.{app.Key}.{root.Key}.read";
    public static string WritePermission(AppDefinition app, EntityDefinition root) => $"app.{app.Key}.{root.Key}.write";

    public bool CanRead(AppDefinition app, EntityDefinition entity)
    {
        var root = MetadataValidator.Root(app, entity);
        return ctx.HasPermission(ReadPermission(app, root)) || ctx.HasPermission(WritePermission(app, root));
    }

    public bool CanWrite(AppDefinition app, EntityDefinition entity) => ctx.HasPermission(WritePermission(app, MetadataValidator.Root(app, entity)));

    async Task<Target?> ResolveAsync(string appKey, string entityKey, CancellationToken ct)
    {
        var app = await registry.GetAsync(appKey, ct);
        var entity = app?.Entity(entityKey);
        return entity is null ? null : new Target(app!, entity, MetadataValidator.Root(app!, entity), SchemaBuilder.Build(app!, entity));
    }

    string Q(string name) => d.Quote(name);

    // ── Read ───────────────────────────────────────────────────────────────

    /// <param name="asSystem">App code reading: the organization scope applies, the user's permissions do not.</param>
    public async Task<(DataResult Result, ListResult? List)> ListAsync(string appKey, string entityKey, ListQuery query, CancellationToken ct = default, bool asSystem = false)
    {
        var t = await ResolveAsync(appKey, entityKey, ct);
        if (t is null) return (DataResult.NotFound, null);
        if (!asSystem && !CanRead(t.App, t.Entity)) return (DataResult.Forbidden("Bu kayıtları görme yetkiniz yok."), null);
        if (t.Entity.Parent is not null && query.ParentId is null) return (DataResult.Invalid("Detay kayıtları üst kayıtla birlikte listelenir."), null);

        await db.Database.OpenConnectionAsync(ct);
        try
        {
            await using var count = Command();
            var where = new List<string> { $"t.{Q("is_deleted")} = @deleted" };
            d.Parameter(count, "@deleted", false);
            if (ScopeFilter(t, "t", where, count, write: false) is { } scopeError) return (DataResult.Forbidden(scopeError), null);
            if (query.ParentId is { } parent)
            {
                where.Add($"t.{Q("parent_id")} = @parent");
                d.Parameter(count, "@parent", parent);
            }
            if (!string.IsNullOrWhiteSpace(query.Search))
            {
                var texts = t.Entity.Fields.Where(f => f.Type is FieldType.Text or FieldType.LongText).ToList();
                if (texts.Count > 0)
                {
                    where.Add("(" + string.Join(" OR ", texts.Select(f => d.Contains($"t.{Q(f.Key)}", "@search"))) + ")");
                    d.Parameter(count, "@search", SqlDialect.ContainsPattern(query.Search.Trim()));
                }
            }
            var from = $"FROM {Q(t.Table.Name)} t";
            var whereSql = "WHERE " + string.Join(" AND ", where);
            count.CommandText = $"SELECT COUNT(*) {from} {whereSql}";
            var total = Convert.ToInt32(await count.ExecuteScalarAsync(ct), CultureInfo.InvariantCulture);

            await using var select = Command();
            foreach (DbParameter p in count.Parameters) d.Parameter(select, p.ParameterName, Original(p));
            var (columns, joins) = SelectList(t);
            var sort = query.Sort ?? t.Entity.List?.SortField;
            var descending = query.Sort is null ? t.Entity.List?.SortDescending ?? (sort is null) : query.Descending;
            var sortColumn = sort is not null && (t.Entity.Field(sort) is not null || sort is "created_at" or "updated_at") ? sort : "created_at";
            d.Parameter(select, "@skip", Math.Max(0, query.Skip));
            d.Parameter(select, "@take", Math.Clamp(query.Take, 1, 500));
            select.CommandText = $"SELECT {columns} {from} {joins} {whereSql} ORDER BY t.{Q(sortColumn)} {(descending ? "DESC" : "ASC")}, t.{Q("id")} {d.Page("@skip", "@take")}";
            var items = new List<Dictionary<string, object?>>();
            await using (var reader = await select.ExecuteReaderAsync(ct))
                while (await reader.ReadAsync(ct)) items.Add(ReadRecord(t, reader));
            return (new DataResult(DataStatus.Ok), new ListResult(items, total));
        }
        finally
        {
            await db.Database.CloseConnectionAsync();
        }
    }

    /// <summary>The parameter's value before dialect conversion was applied (conversion is idempotent for our types).</summary>
    static object? Original(DbParameter p) => p.Value is DBNull ? null : p.Value;

    public async Task<(DataResult Result, Dictionary<string, object?>? Record)> GetAsync(string appKey, string entityKey, Guid id, CancellationToken ct = default, bool asSystem = false)
    {
        var t = await ResolveAsync(appKey, entityKey, ct);
        if (t is null) return (DataResult.NotFound, null);
        if (!asSystem && !CanRead(t.App, t.Entity)) return (DataResult.Forbidden("Bu kaydı görme yetkiniz yok."), null);
        await db.Database.OpenConnectionAsync(ct);
        try
        {
            var record = await LoadAsync(t, id, null, ct);
            return record is null ? (DataResult.NotFound, null) : (new DataResult(DataStatus.Ok, id), record);
        }
        finally
        {
            await db.Database.CloseConnectionAsync();
        }
    }

    async Task<Dictionary<string, object?>?> LoadAsync(Target t, Guid id, IDbContextTransaction? tx, CancellationToken ct)
    {
        await using var cmd = Command(tx);
        var where = new List<string> { $"t.{Q("id")} = @id", $"t.{Q("is_deleted")} = @deleted" };
        d.Parameter(cmd, "@id", id);
        d.Parameter(cmd, "@deleted", false);
        if (ScopeFilter(t, "t", where, cmd, write: false) is not null) return null;
        var (columns, joins) = SelectList(t);
        cmd.CommandText = $"SELECT {columns} FROM {Q(t.Table.Name)} t {joins} WHERE {string.Join(" AND ", where)}";
        await using var reader = await cmd.ExecuteReaderAsync(ct);
        return await reader.ReadAsync(ct) ? ReadRecord(t, reader) : null;
    }

    (string Columns, string Joins) SelectList(Target t)
    {
        var cols = new List<string> { $"t.{Q("id")}", $"t.{Q("row_version")}", $"t.{Q("created_at")}", $"t.{Q("updated_at")}" };
        if (t.Entity.Parent is not null) cols.Add($"t.{Q("parent_id")}");
        foreach (var c in new[] { "company_id", "location_id", "plant_id", "period_id" })
            if (t.Table.Column(c) is not null) cols.Add($"t.{Q(c)}");
        cols.AddRange(t.Entity.Fields.Select(f => $"t.{Q(f.Key)}"));
        var joins = new List<string>();
        var i = 0;
        foreach (var f in t.Entity.Fields.Where(f => f.Type == FieldType.Reference))
        {
            var target = t.App.Entity(f.Reference!)!;
            var alias = $"r{i++}";
            joins.Add($"LEFT JOIN {Q(t.App.TableName(target))} {alias} ON {alias}.{Q("id")} = t.{Q(f.Key)}");
            cols.Add($"{alias}.{Q(target.EffectiveTitleField()!)} AS {Q($"{f.Key}__title")}");
        }
        return (string.Join(", ", cols), string.Join(" ", joins));
    }

    Dictionary<string, object?> ReadRecord(Target t, DbDataReader r)
    {
        var record = new Dictionary<string, object?>();
        var titles = new Dictionary<string, object?>();
        for (var i = 0; i < r.FieldCount; i++)
        {
            var name = r.GetName(i);
            var raw = r.GetValue(i);
            if (name.EndsWith("__title", StringComparison.Ordinal))
            {
                titles[name[..^7]] = raw is DBNull ? null : Convert.ToString(raw, CultureInfo.InvariantCulture);
                continue;
            }
            var value = d.FromDb(raw, t.Table.Column(name)!.Type);
            record[name switch
            {
                "row_version" => "rowVersion",
                "created_at" => "createdAt",
                "updated_at" => "updatedAt",
                "parent_id" => "parentId",
                "company_id" => "companyId",
                "location_id" => "locationId",
                "plant_id" => "plantId",
                "period_id" => "periodId",
                _ => name,
            }] = value;
        }
        if (titles.Count > 0) record["_titles"] = titles;
        return record;
    }

    // ── Write ──────────────────────────────────────────────────────────────

    public async Task<DataResult> CreateAsync(string appKey, string entityKey, JsonElement values, Guid? parentId = null, CancellationToken ct = default)
    {
        var t = await ResolveAsync(appKey, entityKey, ct);
        if (t is null) return DataResult.NotFound;
        if (!CanWrite(t.App, t.Entity)) return DataResult.Forbidden("Bu kayıtları değiştirme yetkiniz yok.");
        if (t.Entity.Parent is not null && parentId is null) return DataResult.Invalid("Detay kayıt bir üst kayda bağlı olmalı.");

        var (fields, errors) = Parse(t.Entity, values, existing: null);
        if (errors.Count > 0) return new DataResult(DataStatus.Invalid, FieldErrors: errors);

        await db.Database.OpenConnectionAsync(ct);
        try
        {
            await using var tx = await db.Database.BeginTransactionAsync(ct);

            // Scope columns: a detail takes its master's; a master takes the request context.
            var system = new Dictionary<string, object?>();
            if (t.Entity.Parent is not null)
            {
                var parent = await ResolveAsync(appKey, t.Entity.Parent, ct);
                var master = await LoadAsync(parent!, parentId!.Value, tx, ct);
                if (master is null) return DataResult.Invalid("Üst kayıt bulunamadı.");
                system["parent_id"] = parentId;
                foreach (var (col, key) in new[] { ("company_id", "companyId"), ("location_id", "locationId"), ("plant_id", "plantId"), ("period_id", "periodId") })
                    if (t.Table.Column(col) is not null) system[col] = master[key];
            }
            else
            {
                if (ContextValues(t, system) is { } contextError) return DataResult.Forbidden(contextError);
            }
            if (system.GetValueOrDefault("period_id") is Guid period && await PeriodClosedAsync(period, ct)) return DataResult.Invalid("Dönem kapalı; kayıt eklenemez.");

            var id = Guid.CreateVersion7();
            if (await RunBeforeSaveAsync(t, id, parentId, fields, isNew: true, tx, ct) is { } refused) return refused;
            var now = time.GetUtcNow().UtcDateTime;
            var columns = new Dictionary<string, object?>(system) { ["id"] = id };
            foreach (var (k, v) in fields) columns[k] = v;
            columns["created_at"] = now;
            columns["created_by"] = ctx.UserId;
            columns["is_deleted"] = false;
            columns["row_version"] = 1;

            await using (var insert = Command(tx))
            {
                var names = columns.Keys.ToList();
                insert.CommandText = $"INSERT INTO {Q(t.Table.Name)} ({string.Join(", ", names.Select(Q))}) VALUES ({string.Join(", ", names.Select((_, i) => $"@p{i}"))})";
                for (var i = 0; i < names.Count; i++) d.Parameter(insert, $"@p{i}", columns[names[i]]);
                await insert.ExecuteNonQueryAsync(ct);
            }
            if (Refused(await code.AfterSaveAsync(t.App, t.Entity, id, parentId, fields, isNew: true, ct)) is { } afterCreate) return afterCreate;
            Audit(t, "create", id, fields.ToDictionary(x => x.Key, x => Display(x.Value)));
            await db.SaveChangesAsync(ct);
            await tx.CommitAsync(ct);
            return DataResult.Ok(id);
        }
        finally
        {
            await db.Database.CloseConnectionAsync();
        }
    }

    public async Task<DataResult> UpdateAsync(string appKey, string entityKey, Guid id, JsonElement values, int rowVersion, CancellationToken ct = default)
    {
        var t = await ResolveAsync(appKey, entityKey, ct);
        if (t is null) return DataResult.NotFound;
        if (!CanWrite(t.App, t.Entity)) return DataResult.Forbidden("Bu kayıtları değiştirme yetkiniz yok.");

        await db.Database.OpenConnectionAsync(ct);
        try
        {
            await using var tx = await db.Database.BeginTransactionAsync(ct);
            var existing = await LoadAsync(t, id, tx, ct);
            if (existing is null) return DataResult.NotFound;
            if (existing.GetValueOrDefault("periodId") is Guid period && await PeriodClosedAsync(period, ct)) return DataResult.Invalid("Dönem kapalı; kayıt değiştirilemez.");

            var (fields, errors) = Parse(t.Entity, values, existing);
            if (errors.Count > 0) return new DataResult(DataStatus.Invalid, FieldErrors: errors);
            var parentId = existing.GetValueOrDefault("parentId") as Guid?;
            if (await RunBeforeSaveAsync(t, id, parentId, fields, isNew: false, tx, ct) is { } refused) return refused;

            var changes = fields.Where(f => !Equals(existing.GetValueOrDefault(f.Key), f.Value))
                .ToDictionary(f => f.Key, f => (object?)new { old = Display(existing.GetValueOrDefault(f.Key)), @new = Display(f.Value) });

            await using (var update = Command(tx))
            {
                var sets = new List<string>();
                var i = 0;
                foreach (var (k, v) in fields)
                {
                    sets.Add($"{Q(k)} = @p{i}");
                    d.Parameter(update, $"@p{i++}", v);
                }
                sets.Add($"{Q("updated_at")} = @now");
                sets.Add($"{Q("updated_by")} = @user");
                sets.Add($"{Q("row_version")} = {Q("row_version")} + 1");
                d.Parameter(update, "@now", time.GetUtcNow().UtcDateTime);
                d.Parameter(update, "@user", ctx.UserId);
                d.Parameter(update, "@id", id);
                d.Parameter(update, "@rv", rowVersion);
                update.CommandText = $"UPDATE {Q(t.Table.Name)} SET {string.Join(", ", sets)} WHERE {Q("id")} = @id AND {Q("row_version")} = @rv";
                if (await update.ExecuteNonQueryAsync(ct) == 0)
                    return new DataResult(DataStatus.Conflict, id, Errors: ["Kayıt siz açtıktan sonra başka biri tarafından değiştirilmiş. Yeniden yükleyip tekrar deneyin."]);
            }
            if (Refused(await code.AfterSaveAsync(t.App, t.Entity, id, parentId, fields, isNew: false, ct)) is { } afterUpdate) return afterUpdate;
            if (changes.Count > 0) Audit(t, "update", id, changes);
            await db.SaveChangesAsync(ct);
            await tx.CommitAsync(ct);
            return DataResult.Ok(id);
        }
        finally
        {
            await db.Database.CloseConnectionAsync();
        }
    }

    public async Task<DataResult> DeleteAsync(string appKey, string entityKey, Guid id, CancellationToken ct = default)
    {
        var t = await ResolveAsync(appKey, entityKey, ct);
        if (t is null) return DataResult.NotFound;
        if (!CanWrite(t.App, t.Entity)) return DataResult.Forbidden("Bu kayıtları değiştirme yetkiniz yok.");

        await db.Database.OpenConnectionAsync(ct);
        try
        {
            await using var tx = await db.Database.BeginTransactionAsync(ct);
            var existing = await LoadAsync(t, id, tx, ct);
            if (existing is null) return DataResult.NotFound;
            if (existing.GetValueOrDefault("periodId") is Guid period && await PeriodClosedAsync(period, ct)) return DataResult.Invalid("Dönem kapalı; kayıt silinemez.");
            var current = t.Entity.Fields.ToDictionary(f => f.Key, f => existing.GetValueOrDefault(f.Key));
            var outcome = await code.BeforeDeleteAsync(t.App, t.Entity, id, existing.GetValueOrDefault("parentId") as Guid?, current, ct);
            if (outcome.Refused) return new DataResult(DataStatus.Invalid, FieldErrors: outcome.FieldErrors, Errors: outcome.Errors.Count > 0 ? [.. outcome.Errors] : null);

            // Records still pointing at it (not deleted) keep it.
            foreach (var other in t.App.Entities)
                foreach (var f in other.Fields.Where(f => f.Type == FieldType.Reference && f.Reference == t.Entity.Key))
                {
                    await using var used = Command(tx);
                    d.Parameter(used, "@id", id);
                    d.Parameter(used, "@deleted", false);
                    used.CommandText = $"SELECT COUNT(*) FROM {Q(t.App.TableName(other))} WHERE {Q(f.Key)} = @id AND {Q("is_deleted")} = @deleted";
                    if (Convert.ToInt32(await used.ExecuteScalarAsync(ct), CultureInfo.InvariantCulture) > 0)
                        return DataResult.Invalid($"Bu kayıt '{other.DisplayPlural}' kayıtlarında kullanılıyor; silinemez.");
                }

            var now = time.GetUtcNow().UtcDateTime;
            await SoftDeleteAsync(t.App, t.Entity, "id", id, now, tx, ct);
            Audit(t, "delete", id, existing.Where(x => t.Entity.Field(x.Key) is not null).ToDictionary(x => x.Key, x => Display(x.Value)));
            await db.SaveChangesAsync(ct);
            await tx.CommitAsync(ct);
            return DataResult.Ok(id);
        }
        finally
        {
            await db.Database.CloseConnectionAsync();
        }
    }

    /// <summary>Marks the record (or a master's details) deleted, then the details of those, down the chain.</summary>
    async Task SoftDeleteAsync(AppDefinition app, EntityDefinition entity, string column, Guid value, DateTime now, IDbContextTransaction tx, CancellationToken ct)
    {
        var table = Q(app.TableName(entity));
        var ids = new List<Guid>();
        if (app.Children(entity).Any())
        {
            await using var select = Command(tx);
            d.Parameter(select, "@v", value);
            d.Parameter(select, "@deleted", false);
            select.CommandText = $"SELECT {Q("id")} FROM {table} WHERE {Q(column)} = @v AND {Q("is_deleted")} = @deleted";
            await using var reader = await select.ExecuteReaderAsync(ct);
            while (await reader.ReadAsync(ct)) ids.Add((Guid)d.FromDb(reader.GetValue(0), ColumnType.Guid)!);
        }
        await using (var update = Command(tx))
        {
            d.Parameter(update, "@v", value);
            d.Parameter(update, "@yes", true);
            d.Parameter(update, "@no", false);
            d.Parameter(update, "@now", now);
            d.Parameter(update, "@user", ctx.UserId);
            update.CommandText = $"UPDATE {table} SET {Q("is_deleted")} = @yes, {Q("updated_at")} = @now, {Q("updated_by")} = @user, {Q("row_version")} = {Q("row_version")} + 1 WHERE {Q(column)} = @v AND {Q("is_deleted")} = @no";
            await update.ExecuteNonQueryAsync(ct);
        }
        foreach (var child in app.Children(entity))
            foreach (var id in ids)
                await SoftDeleteAsync(app, child, "parent_id", id, now, tx, ct);
    }

    /// <summary>
    /// The app's Validate and BeforeSave events, then the engine's own checks again on what they
    /// left (BeforeSave may change values) and the references. Null = go ahead.
    /// </summary>
    async Task<DataResult?> RunBeforeSaveAsync(Target t, Guid id, Guid? parentId, Dictionary<string, object?> fields, bool isNew, IDbContextTransaction tx, CancellationToken ct)
    {
        var outcome = await code.BeforeSaveAsync(t.App, t.Entity, id, parentId, fields, isNew, ct);
        if (outcome.Refused) return new DataResult(DataStatus.Invalid, FieldErrors: outcome.FieldErrors, Errors: outcome.Errors.Count > 0 ? [.. outcome.Errors] : null);
        var errors = Recheck(t.Entity, fields);
        if (errors.Count > 0) return new DataResult(DataStatus.Invalid, FieldErrors: errors);
        var refErrors = await CheckReferencesAsync(t, fields, tx, ct);
        return refErrors.Count > 0 ? new DataResult(DataStatus.Invalid, FieldErrors: refErrors) : null;
    }

    /// <summary>A refusal of app code as a result (the transaction is then not committed).</summary>
    static DataResult? Refused(CodeOutcome o) =>
        o.Refused ? new DataResult(DataStatus.Invalid, FieldErrors: o.FieldErrors, Errors: o.Errors.Count > 0 ? [.. o.Errors] : null) : null;

    /// <summary>Required, length and choice rules on the final values (after the app code ran).</summary>
    static Dictionary<string, string> Recheck(EntityDefinition entity, Dictionary<string, object?> values)
    {
        var errors = new Dictionary<string, string>();
        foreach (var f in entity.Fields)
        {
            var v = values.GetValueOrDefault(f.Key);
            if (v is string { Length: 0 }) values[f.Key] = v = null;
            if (v is null)
            {
                if (f.Required) errors[f.Key] = "Zorunlu alan.";
                continue;
            }
            var max = f.MaxLength ?? FieldDefinition.DefaultMaxLength;
            var scale = f.Scale ?? FieldDefinition.DefaultScale;
            if (f.Type == FieldType.Text && v is string s && s.Length > max) errors[f.Key] = $"En fazla {max} karakter.";
            else if (f.Type == FieldType.Choice && v is string c && f.Choices!.All(o => o.Value != c)) errors[f.Key] = "Geçerli bir seçenek seçin.";
            else if (f.Type == FieldType.Decimal && v is decimal m && decimal.Round(m, scale) != m) values[f.Key] = decimal.Round(m, scale, MidpointRounding.AwayFromZero);
        }
        return errors;
    }

    // ── Values ─────────────────────────────────────────────────────────────

    /// <summary>
    /// The field values of a create (all fields) or an update (fields not sent keep their
    /// value). Required fields are checked on the final values.
    /// </summary>
    (Dictionary<string, object?> Values, Dictionary<string, string> Errors) Parse(EntityDefinition entity, JsonElement json, Dictionary<string, object?>? existing)
    {
        var values = new Dictionary<string, object?>();
        var errors = new Dictionary<string, string>();
        if (json.ValueKind != JsonValueKind.Object)
        {
            errors[""] = "Kayıt bir JSON nesnesi olmalı.";
            return (values, errors);
        }
        foreach (var f in entity.Fields)
        {
            object? value;
            if (json.TryGetProperty(f.Key, out var el))
            {
                var error = ParseValue(f, el, out value);
                if (error is not null)
                {
                    errors[f.Key] = error;
                    continue;
                }
            }
            else value = existing?.GetValueOrDefault(f.Key);
            values[f.Key] = value;
        }
        // App code may still fill required fields (BeforeSave); only when the save stops here
        // anyway are the missing ones reported with the other errors.
        if (errors.Count > 0)
            foreach (var f in entity.Fields.Where(f => f.Required && !errors.ContainsKey(f.Key) && values.GetValueOrDefault(f.Key) is null))
                errors[f.Key] = "Zorunlu alan.";
        return (values, errors);
    }

    static string? ParseValue(FieldDefinition f, JsonElement el, out object? value)
    {
        value = null;
        if (el.ValueKind is JsonValueKind.Null or JsonValueKind.Undefined) return null;
        if (el.ValueKind == JsonValueKind.String && el.GetString() is { Length: 0 } && f.Type != FieldType.Boolean) return null;
        try
        {
            switch (f.Type)
            {
                case FieldType.Text or FieldType.LongText:
                    var s = el.ValueKind == JsonValueKind.String ? el.GetString()! : el.GetRawText();
                    var max = f.Type == FieldType.Text ? f.MaxLength ?? FieldDefinition.DefaultMaxLength : int.MaxValue;
                    if (s.Length > max) return $"En fazla {max} karakter.";
                    value = s;
                    return null;
                case FieldType.Choice:
                    var c = el.GetString()!;
                    if (f.Choices!.All(o => o.Value != c)) return "Geçerli bir seçenek seçin.";
                    value = c;
                    return null;
                case FieldType.Integer:
                    value = el.ValueKind == JsonValueKind.Number ? el.GetInt64() : long.Parse(el.GetString()!, CultureInfo.InvariantCulture);
                    return null;
                case FieldType.Decimal:
                    var m = el.ValueKind == JsonValueKind.Number ? el.GetDecimal() : decimal.Parse(el.GetString()!, CultureInfo.InvariantCulture);
                    var scale = f.Scale ?? FieldDefinition.DefaultScale;
                    var precision = f.Precision ?? FieldDefinition.DefaultPrecision;
                    if (decimal.Round(m, scale) != m) return $"En fazla {scale} ondalık basamak.";
                    if (Math.Abs(decimal.Truncate(m)).ToString(CultureInfo.InvariantCulture).TrimStart('0').Length > precision - scale) return "Sayı çok büyük.";
                    value = m;
                    return null;
                case FieldType.Date:
                    value = DateOnly.ParseExact(el.GetString()!, "yyyy-MM-dd", CultureInfo.InvariantCulture);
                    return null;
                case FieldType.DateTime:
                    value = DateTimeOffset.Parse(el.GetString()!, CultureInfo.InvariantCulture).UtcDateTime;
                    return null;
                case FieldType.Boolean:
                    value = el.ValueKind switch { JsonValueKind.True => true, JsonValueKind.False => false, _ => bool.Parse(el.GetString()!) };
                    return null;
                case FieldType.Reference:
                    value = el.GetGuid();
                    return null;
            }
        }
        catch (Exception e) when (e is FormatException or InvalidOperationException or OverflowException)
        {
            return f.Type switch
            {
                FieldType.Integer => "Tam sayı girin.",
                FieldType.Decimal => "Sayı girin.",
                FieldType.Date => "Tarih girin (yyyy-aa-gg).",
                FieldType.DateTime => "Tarih ve saat girin.",
                FieldType.Boolean => "Evet ya da hayır seçin.",
                FieldType.Reference => "Geçerli bir kayıt seçin.",
                _ => "Geçersiz değer.",
            };
        }
        return "Geçersiz değer.";
    }

    /// <summary>A referenced record must exist, not be deleted and be visible in the current context.</summary>
    async Task<Dictionary<string, string>> CheckReferencesAsync(Target t, Dictionary<string, object?> fields, IDbContextTransaction tx, CancellationToken ct)
    {
        var errors = new Dictionary<string, string>();
        foreach (var f in t.Entity.Fields.Where(f => f.Type == FieldType.Reference))
        {
            if (fields.GetValueOrDefault(f.Key) is not Guid id) continue;
            var target = t.App.Entity(f.Reference!)!;
            var rt = new Target(t.App, target, MetadataValidator.Root(t.App, target), SchemaBuilder.Build(t.App, target));
            if (await LoadAsync(rt, id, tx, ct) is null) errors[f.Key] = $"Seçilen {target.Name.ToLower(new CultureInfo("tr-TR"))} bulunamadı.";
        }
        return errors;
    }

    // ── Scope ──────────────────────────────────────────────────────────────

    /// <summary>Adds the scope conditions of the request context; an error when the context lacks what the entity needs.</summary>
    string? ScopeFilter(Target t, string alias, List<string> where, DbCommand cmd, bool write)
    {
        var scope = t.App.EffectiveScope(t.Entity);
        if (scope >= EntityScope.Company)
        {
            if (ctx.CompanyId is not { } company) return "Önce çalışma bağlamını (firma ve lokasyon) seçin.";
            where.Add($"{alias}.{Q("company_id")} = @ctx_company");
            d.Parameter(cmd, "@ctx_company", company);
        }
        if (scope >= EntityScope.Location)
        {
            if (ctx.LocationId is not { } location) return "Önce çalışma bağlamını (firma ve lokasyon) seçin.";
            where.Add($"{alias}.{Q("location_id")} = @ctx_location");
            d.Parameter(cmd, "@ctx_location", location);
        }
        if (scope >= EntityScope.Plant)
        {
            if (ctx.PlantId is { } plant)
            {
                where.Add($"{alias}.{Q("plant_id")} = @ctx_plant");
                d.Parameter(cmd, "@ctx_plant", plant);
            }
            else if (write) return "Bu kayıtlar plant'a bağlı: çalışma bağlamında bir plant seçin.";
        }
        if (t.App.EffectivePeriodBound(t.Entity))
        {
            if (ctx.PeriodId is not { } period) return "Bu kayıtlar döneme bağlı: çalışma bağlamında bir dönem seçin.";
            where.Add($"{alias}.{Q("period_id")} = @ctx_period");
            d.Parameter(cmd, "@ctx_period", period);
        }
        return null;
    }

    string? ContextValues(Target t, Dictionary<string, object?> values)
    {
        var scope = t.App.EffectiveScope(t.Entity);
        if (scope >= EntityScope.Company && ctx.CompanyId is null) return "Önce çalışma bağlamını (firma ve lokasyon) seçin.";
        if (scope >= EntityScope.Location && ctx.LocationId is null) return "Önce çalışma bağlamını (firma ve lokasyon) seçin.";
        if (scope >= EntityScope.Plant && ctx.PlantId is null) return "Bu kayıtlar plant'a bağlı: çalışma bağlamında bir plant seçin.";
        if (t.App.EffectivePeriodBound(t.Entity) && ctx.PeriodId is null) return "Bu kayıtlar döneme bağlı: çalışma bağlamında bir dönem seçin.";
        if (scope >= EntityScope.Company) values["company_id"] = ctx.CompanyId;
        if (scope >= EntityScope.Location) values["location_id"] = ctx.LocationId;
        if (scope >= EntityScope.Plant) values["plant_id"] = ctx.PlantId;
        if (t.App.EffectivePeriodBound(t.Entity)) values["period_id"] = ctx.PeriodId;
        return null;
    }

    Task<bool> PeriodClosedAsync(Guid period, CancellationToken ct) =>
        db.Periods.AnyAsync(p => p.Id == period && p.IsClosed, ct);

    // ── Helpers ────────────────────────────────────────────────────────────

    DbCommand Command(IDbContextTransaction? tx = null)
    {
        var cmd = db.Database.GetDbConnection().CreateCommand();
        var current = tx ?? db.Database.CurrentTransaction;
        if (current is not null) cmd.Transaction = current.GetDbTransaction();
        return cmd;
    }

    void Audit(Target t, string verb, Guid id, Dictionary<string, object?> data) =>
        db.AuditEvents.Add(new AuditEvent
        {
            At = time.GetUtcNow().UtcDateTime,
            Category = "data",
            Action = $"{t.App.Key}.{t.Entity.Key}.{verb}",
            UserId = ctx.UserId,
            UserName = ctx.UserName,
            SessionId = ctx.SessionId,
            IpAddress = ctx.IpAddress,
            EntityType = $"{t.App.Key}.{t.Entity.Key}",
            EntityId = id.ToString(),
            Data = JsonSerializer.Serialize(data),
        });

    static object? Display(object? value) => value switch
    {
        DateOnly date => date.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture),
        DateTime dt => dt.ToString("o", CultureInfo.InvariantCulture),
        _ => value,
    };
}
