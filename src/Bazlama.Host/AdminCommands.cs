using System.Text;
using Bazlama.Kernel;
using Bazlama.Kernel.Data;
using Bazlama.Modules.Identity;
using Bazlama.Packaging;
using Microsoft.EntityFrameworkCore;

namespace Bazlama.Host;

/// <summary>
/// Commands run on the server's console instead of starting the web host, for an administrator
/// with access to the machine:
/// <c>Bazlama.Host reset-password &lt;user&gt;</c> (a forgotten password),
/// <c>Bazlama.Host pack-app &lt;folder&gt; [output]</c> (an app kept as source files → .bzapp).
/// </summary>
static class AdminCommands
{
    public static bool IsCommand(string[] args) => args.Length > 0 && args[0] is "reset-password" or "pack-app";

    /// <returns>The process exit code.</returns>
    public static async Task<int> RunAsync(WebApplication app, string[] args)
    {
        Console.OutputEncoding = Encoding.UTF8;
        return args[0] == "pack-app" ? PackApp(app, args) : await ResetPasswordAsync(app, args);
    }

    /// <summary>samples/apps/siparis → siparis-2.0.0.bzapp (in the current folder, or the given file or folder).</summary>
    static int PackApp(WebApplication app, string[] args)
    {
        if (args.Length is < 2 or > 3)
        {
            Console.Error.WriteLine("Kullanım: Bazlama.Host pack-app <uygulama klasörü> [çıktı dosyası ya da klasörü]");
            return 2;
        }
        var platform = app.Services.GetRequiredService<PlatformInfo>();
        var now = app.Services.GetRequiredService<TimeProvider>().GetUtcNow().UtcDateTime;
        var (bytes, name, errors) = SourcePackager.Pack(Path.GetFullPath(args[1]), platform.Version, now, "pack-app");
        if (bytes is null)
        {
            Console.Error.WriteLine("Paket oluşturulamadı:");
            foreach (var e in errors) Console.Error.WriteLine($"  {e}");
            return 1;
        }
        var target = args.Length == 3 ? Path.GetFullPath(args[2]) : Path.GetFullPath(name!);
        if (Directory.Exists(target)) target = Path.Combine(target, name!);
        File.WriteAllBytes(target, bytes);
        Console.WriteLine($"{target} yazıldı ({bytes.Length / 1024.0:N1} KB). Yönetim › Uygulamalar › Paket içe aktar ile kurun.");
        return 0;
    }

    static async Task<int> ResetPasswordAsync(WebApplication app, string[] args)
    {
        if (args.Length != 2)
        {
            Console.Error.WriteLine("Kullanım: Bazlama.Host reset-password <kullanıcı adı>");
            return 2;
        }
        await using var scope = app.Services.CreateAsyncScope();
        var services = scope.ServiceProvider;
        var db = services.GetRequiredService<KernelDbContext>();
        var user = await db.Users.FirstOrDefaultAsync(u => u.UserName == args[1]);
        if (user is null)
        {
            Console.Error.WriteLine($"Kullanıcı bulunamadı: {args[1]}");
            return 1;
        }

        var passwords = services.GetRequiredService<PasswordService>();
        var policy = await services.GetRequiredService<SecuritySettingsStore>().GetAsync();
        var password = ReadSecret($"{user.UserName} için yeni parola: ");
        var errors = await passwords.ValidateAsync(user, password, policy);
        if (errors.Count > 0)
        {
            foreach (var e in errors) Console.Error.WriteLine(e);
            return 1;
        }
        if (ReadSecret("Yeni parola (tekrar): ") != password)
        {
            Console.Error.WriteLine("Parolalar aynı değil.");
            return 1;
        }

        passwords.SetPassword(user, password, mustChange: false);
        user.FailedLoginCount = 0;
        user.LockoutEndsAt = null;
        user.IsActive = true;
        await db.SaveChangesAsync();
        await services.GetRequiredService<SessionStore>().EndAllOfUserAsync(user.Id, "password-reset");
        Console.WriteLine($"{user.UserName} kullanıcısının parolası değiştirildi; kilidi açıldı, açık oturumları kapatıldı.");
        return 0;
    }

    /// <summary>Reads a line without echoing it (a redirected input is read as is).</summary>
    static string ReadSecret(string prompt)
    {
        Console.Write(prompt);
        if (Console.IsInputRedirected) return Console.ReadLine() ?? "";
        var text = new StringBuilder();
        while (true)
        {
            var key = Console.ReadKey(intercept: true);
            if (key.Key == ConsoleKey.Enter) break;
            if (key.Key == ConsoleKey.Backspace)
            {
                if (text.Length > 0) text.Length--;
            }
            else if (!char.IsControl(key.KeyChar)) text.Append(key.KeyChar);
        }
        Console.WriteLine();
        return text.ToString();
    }
}
