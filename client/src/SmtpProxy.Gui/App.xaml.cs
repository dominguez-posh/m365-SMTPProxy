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
            MessageBox.Show(ex.Exception.Message, Paths.DisplayName, MessageBoxButton.OK, MessageBoxImage.Error);
            ex.Handled = true;
        };
        base.OnStartup(e);
    }
}
