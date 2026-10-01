using Bazlama.Kernel.Identity;

namespace Bazlama.Engine;

public sealed record PermissionInfo(string Key, string Title, string? Group = null);

/// <summary>Kernel permissions plus read/write for each master entity of every installed app.</summary>
public sealed class PermissionCatalog(AppRegistry registry)
{
    public async Task<IReadOnlyList<PermissionInfo>> AllAsync(CancellationToken ct = default)
    {
        var list = Permissions.Catalog.Select(p => new PermissionInfo(p.Key, p.Title, "Sistem")).ToList();
        foreach (var app in (await registry.AllAsync(ct)).Values.OrderBy(a => a.Name))
            foreach (var e in app.Entities.Where(e => e.Parent is null))
            {
                list.Add(new(DataService.ReadPermission(app, e), $"{e.DisplayPlural}: görüntüle", app.Name));
                list.Add(new(DataService.WritePermission(app, e), $"{e.DisplayPlural}: ekle, değiştir, sil", app.Name));
            }
        return list;
    }
}
