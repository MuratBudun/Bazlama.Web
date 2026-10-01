using Bazlama.Engine.Metadata;

namespace Bazlama.Engine.Schema;

public enum ChangeKind { CreateTable, DropTable, AddColumn, DropColumn, AlterColumn, CreateIndex, DropIndex, AddForeignKey }

/// <summary>
/// One step of a schema change. <see cref="Old"/>/<see cref="New"/> are the whole table before
/// and after, so a dialect can rebuild a table when it cannot alter it in place (SQLite).
/// </summary>
public sealed record SchemaChange(ChangeKind Kind, TableSchema? Old, TableSchema? New, string? Column = null, IndexSchema? Index = null, ForeignKeySchema? ForeignKey = null)
{
    public string Table => (New ?? Old)!.Name;

    /// <summary>Loses data: needs an explicit confirmation.</summary>
    public bool Destructive => Kind is ChangeKind.DropTable or ChangeKind.DropColumn;

    public string Description => Kind switch
    {
        ChangeKind.CreateTable => $"Tablo oluşturulacak: {Table}",
        ChangeKind.DropTable => $"Tablo silinecek (veriler kaybolur): {Table}",
        ChangeKind.AddColumn => $"Kolon eklenecek: {Table}.{Column}",
        ChangeKind.DropColumn => $"Kolon silinecek (veriler kaybolur): {Table}.{Column}",
        ChangeKind.AlterColumn => $"Kolon genişletilecek: {Table}.{Column}",
        ChangeKind.CreateIndex => $"İndeks oluşturulacak: {Index!.Name}",
        ChangeKind.DropIndex => $"İndeks silinecek: {Index!.Name}",
        ChangeKind.AddForeignKey => $"İlişki eklenecek: {Table}.{ForeignKey!.Column} → {ForeignKey.RefTable}",
        _ => Kind.ToString(),
    };
}

/// <summary>What installing a version changes; <see cref="Errors"/> are changes the engine refuses.</summary>
public sealed record SchemaPlan(IReadOnlyList<SchemaChange> Changes, IReadOnlyList<string> Errors)
{
    public bool HasDestructive => Changes.Any(c => c.Destructive);
}

public static class SchemaDiff
{
    /// <summary>The changes from the installed version (null: not installed) to a new one, in execution order.</summary>
    public static SchemaPlan Compare(AppDefinition? installed, AppDefinition next)
    {
        var errors = new List<string>();
        var before = installed is null ? new Dictionary<string, (EntityDefinition E, TableSchema T)>()
            : installed.Entities.ToDictionary(e => e.Key, e => (e, SchemaBuilder.Build(installed, e)));
        var after = next.Entities.ToDictionary(e => e.Key, e => (E: e, T: SchemaBuilder.Build(next, e)));

        var drops = new List<SchemaChange>();     // indexes and columns/tables going away
        var creates = new List<SchemaChange>();   // tables and columns coming
        var finish = new List<SchemaChange>();    // indexes and foreign keys of new things

        foreach (var (key, (oldE, oldT)) in before)
            if (!after.ContainsKey(key)) drops.Add(new(ChangeKind.DropTable, oldT, null));

        foreach (var (key, (newE, newT)) in after)
        {
            if (!before.TryGetValue(key, out var old))
            {
                creates.Add(new(ChangeKind.CreateTable, null, newT));
                finish.AddRange(newT.Indexes.Select(i => new SchemaChange(ChangeKind.CreateIndex, null, newT, Index: i)));
                finish.AddRange(newT.ForeignKeys.Select(f => new SchemaChange(ChangeKind.AddForeignKey, null, newT, f.Column, ForeignKey: f)));
                continue;
            }

            var (oldE, oldT) = old;
            var at = $"Entity '{key}'";
            var inst = installed!;
            if (inst.EffectiveScope(oldE) != next.EffectiveScope(newE)) errors.Add($"{at}: kapsam değiştirilemez ({inst.EffectiveScope(oldE)} → {next.EffectiveScope(newE)}).");
            if (inst.EffectivePeriodBound(oldE) != next.EffectivePeriodBound(newE)) errors.Add($"{at}: dönem bağlılığı değiştirilemez.");
            if (oldE.Parent != newE.Parent) errors.Add($"{at}: üst entity değiştirilemez.");

            foreach (var i in oldT.Indexes.Where(i => newT.Indexes.All(n => n.Name != i.Name)))
                drops.Add(new(ChangeKind.DropIndex, oldT, newT, Index: i));
            foreach (var c in oldT.Columns.Where(c => newT.Column(c.Name) is null))
                drops.Add(new(ChangeKind.DropColumn, oldT, newT, c.Name));

            foreach (var c in newT.Columns)
            {
                var was = oldT.Column(c.Name);
                if (was is null)
                {
                    creates.Add(new(ChangeKind.AddColumn, oldT, newT, c.Name, ForeignKey: newT.ForeignKey(c.Name)));
                    continue;
                }
                if (was.Type != c.Type || was.Precision != c.Precision || was.Scale != c.Scale)
                    errors.Add($"{at}, alan '{c.Name}': tipi değiştirilemez; yeni bir alan ekleyin.");
                else if (c.Length is { } len && was.Length is { } wasLen && len != wasLen)
                {
                    if (len < wasLen) errors.Add($"{at}, alan '{c.Name}': uzunluk kısaltılamaz ({wasLen} → {len}).");
                    else creates.Add(new(ChangeKind.AlterColumn, oldT, newT, c.Name));
                }
                if (was.Type == c.Type && oldT.ForeignKey(c.Name)?.RefTable != newT.ForeignKey(c.Name)?.RefTable && oldT.ForeignKey(c.Name) is not null)
                    errors.Add($"{at}, alan '{c.Name}': referans verdiği entity değiştirilemez.");
            }
            foreach (var i in newT.Indexes.Where(i => oldT.Indexes.All(o => o.Name != i.Name)))
                finish.Add(new(ChangeKind.CreateIndex, oldT, newT, Index: i));
        }

        // Details before masters when dropping tables (foreign keys).
        var tableDrops = drops.Where(d => d.Kind == ChangeKind.DropTable)
            .OrderByDescending(d => installed is null ? 0 : Depth(installed, installed.Entities.First(e => installed.TableName(e) == d.Table)));
        var ordered = drops.Where(d => d.Kind == ChangeKind.DropIndex)
            .Concat(drops.Where(d => d.Kind == ChangeKind.DropColumn))
            .Concat(tableDrops)
            .Concat(creates)
            .Concat(finish)
            .ToList();
        return new SchemaPlan(ordered, errors);
    }

    static int Depth(AppDefinition app, EntityDefinition e)
    {
        var depth = 0;
        for (var p = e.Parent; p is not null && depth < app.Entities.Count; p = app.Entity(p)?.Parent) depth++;
        return depth;
    }
}
