using System.Net;
using System.Net.Http.Json;
using static Bazlama.Tests.TestHost;

namespace Bazlama.Tests.Host;

public sealed class SystemInfoTests : IAsyncLifetime
{
    readonly TestHost host = new(environmentMode: "Test");

    public async ValueTask InitializeAsync() => await host.SetupAsync();
    public ValueTask DisposeAsync() => host.DisposeAsync();

    record SystemInfo(string Product, string Version, string Environment, string DatabaseProvider);

    [Fact]
    public async Task Reports_installation_and_provider_to_signed_in_users()
    {
        var client = host.Client();
        Assert.Equal(HttpStatusCode.Unauthorized, (await client.GetAsync("/api/system/info", Ct)).StatusCode);

        await client.LoginAsync(AdminUser, AdminPassword);
        var info = await client.GetFromJsonAsync<SystemInfo>("/api/system/info", Ct);
        Assert.NotNull(info);
        Assert.Equal("Bazlama", info.Product);
        Assert.Equal("Test", info.Environment);
        Assert.Equal("Sqlite", info.DatabaseProvider);
    }

    [Fact]
    public async Task Unknown_api_path_is_404_not_the_web_ui()
    {
        var res = await host.Client().GetAsync("/api/nope", Ct);
        Assert.Equal(HttpStatusCode.NotFound, res.StatusCode);
    }
}
