using SmtpProxy.Core;
using SmtpProxy.Core.Management;
using SmtpProxy.Service;

// uninstall: leave the management server and delete the key (install.ps1 -Uninstall)
if (args.Contains("--unregister"))
{
    await ManagementClient.UnregisterAsync(CancellationToken.None);
    return;
}

var builder = Host.CreateApplicationBuilder(args);
builder.Services.AddWindowsService(o => o.ServiceName = Paths.ServiceName);
builder.Services.AddHostedService<ProxyService>();
builder.Build().Run();
