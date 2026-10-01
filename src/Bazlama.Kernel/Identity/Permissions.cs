namespace Bazlama.Kernel.Identity;

/// <summary>Kernel permissions. Apps register their own (app.&lt;appKey&gt;.…) when installed.</summary>
public static class Permissions
{
    /// <summary>Grants everything (the Administrators group).</summary>
    public const string All = "*";

    public const string Users = "system.users";
    public const string Groups = "system.groups";
    public const string Organization = "system.organization";
    public const string Sessions = "system.sessions";
    public const string Settings = "system.settings";
    public const string Audit = "system.audit";
    public const string Development = "development.access";

    public static readonly IReadOnlyList<(string Key, string Title)> Catalog =
    [
        (All, "Tüm yetkiler"),
        (Users, "Kullanıcıları yönet"),
        (Groups, "Grupları ve izinleri yönet"),
        (Organization, "Firma, lokasyon, plant ve dönemleri yönet"),
        (Sessions, "Oturumları gör ve sonlandır"),
        (Settings, "Güvenlik ayarlarını yönet"),
        (Audit, "Audit kayıtlarını gör"),
        (Development, "Geliştirme alanını kullan"),
    ];

    public static bool Grants(IReadOnlySet<string> granted, string permission) =>
        granted.Contains(All) || granted.Contains(permission);
}
