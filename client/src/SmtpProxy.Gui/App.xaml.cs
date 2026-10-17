using System.IO;
using System.Reflection;
using System.Windows;
using SmtpProxy.Core;

namespace SmtpProxy.Gui;

public partial class App : Application
{
    protected override void OnStartup(StartupEventArgs e)
    {
        Paths.Ensure();
        DispatcherUnhandledException += (_, ex) =>
        {
            // reflection and XAML wrap the real error: show the innermost one and keep the details in logs\gui-error.log
            var inner = ex.Exception;
            while (inner is TargetInvocationException or System.Windows.Markup.XamlParseException && inner.InnerException is not null)
                inner = inner.InnerException;
            var file = Path.Combine(Paths.LogDir, "gui-error.log");
            try { File.AppendAllText(file, $"{DateTime.Now:s} {Paths.Version}\n{ex.Exception}\n\n"); } catch { }
            MessageBox.Show($"{inner.Message}\n\nDetails: {file}", Paths.DisplayName, MessageBoxButton.OK, MessageBoxImage.Error);
            ex.Handled = true;
        };
        base.OnStartup(e);
    }
}
