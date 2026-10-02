using Bazlama.Engine;
using Bazlama.Engine.Metadata;
using Bazlama.Engine.Schema;
using Bazlama.Kernel;
using Bazlama.Kernel.Code;
using Bazlama.Kernel.Data;
using Microsoft.EntityFrameworkCore;

namespace Bazlama.Compiler;

public sealed record PreviewResult(string Key, IReadOnlyList<string> Errors, IReadOnlyList<string> Changes, bool Reset, CompileOutput? Code)
{
    public bool Ready => Errors.Count == 0;
}

/// <summary>
/// Previews of drafts: the draft is installed under the app's preview key (its own tables,
/// app_&lt;key&gt;_pv_…) and the saved code is compiled against it, so the app can be tried with real
/// data and code before it is published. Preview data is disposable: changes that drop columns
/// apply without asking, and changes an upgrade would refuse (type, scope, parent) start the
/// preview's tables over.
/// </summary>
public sealed class PreviewService(KernelDbContext db, AppRegistry registry, AppInstaller installer, CodeBuildService builds, AppCodeHost host, IRequestContext request, TimeProvider time)
{
    /// <param name="reset">Starts the preview's tables over (its records are deleted).</param>
    public async Task<PreviewResult?> PrepareAsync(string appKey, bool reset, CancellationToken ct)
    {
        var draft = await builds.EditingDefinitionAsync(appKey, ct);
        if (draft is null) return null;
        var key = AppDefinition.PreviewKey(appKey);
        var errors = MetadataValidator.Validate(draft);
        if (errors.Count > 0) return new(key, errors, [], false, null);

        var next = draft.AsPreview();
        var row = await db.AppPreviews.FirstOrDefaultAsync(p => p.AppKey == appKey, ct);
        var current = row is null ? null : AppDefinition.Parse(row.Definition).AsPreview();

        var plan = SchemaDiff.Compare(reset ? null : current, next);
        if (!reset && plan.Errors.Count > 0) reset = true;
        var changes = new List<SchemaChange>();
        if (reset && current is not null)
        {
            // Every table of the old preview goes (details first: they reference their masters).
            var empty = current.AsPreviewWithout();
            changes.AddRange(SchemaDiff.Compare(current, empty).Changes);
            plan = SchemaDiff.Compare(null, next);
        }
        changes.AddRange(plan.Changes);

        var now = time.GetUtcNow().UtcDateTime;
        await installer.ApplySchemaAsync(changes, () =>
        {
            row ??= db.AppPreviews.Add(new AppPreview { AppKey = appKey, Definition = "" }).Entity;
            row.Definition = draft.ToJson();
            row.UpdatedAt = now;
            row.UpdatedBy = request.UserId;
            return Task.CompletedTask;
        }, ct);
        registry.InvalidatePreviews();

        var code = await builds.LoadPreviewAsync(draft, ct);
        return new(key, [], [.. changes.Select(c => c.Description)], reset && current is not null, code);
    }

    /// <summary>Drops a preview's tables and forgets it (e.g. after publishing).</summary>
    public async Task<bool> RemoveAsync(string appKey, CancellationToken ct)
    {
        var row = await db.AppPreviews.FirstOrDefaultAsync(p => p.AppKey == appKey, ct);
        if (row is null) return false;
        var current = AppDefinition.Parse(row.Definition).AsPreview();
        await installer.ApplySchemaAsync(SchemaDiff.Compare(current, current.AsPreviewWithout()).Changes, () =>
        {
            db.AppPreviews.Remove(row);
            return Task.CompletedTask;
        }, ct);
        registry.InvalidatePreviews();
        host.Unload(AppDefinition.PreviewKey(appKey));
        return true;
    }
}
