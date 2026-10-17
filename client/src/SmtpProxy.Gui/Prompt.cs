using System.Windows;
using System.Windows.Controls;

namespace SmtpProxy.Gui;

/// <summary>Small input and message dialogs (WPF has no InputBox).</summary>
public static class Prompt
{
    /// <summary>Asks for several values; null if cancelled.</summary>
    public static string[]? Ask(Window owner, string title, params (string Label, string Value)[] fields)
    {
        var panel = new StackPanel { Margin = new Thickness(20) };
        var boxes = new List<TextBox>();
        foreach (var (label, value) in fields)
        {
            panel.Children.Add(new TextBlock { Text = label, Margin = new Thickness(0, 8, 0, 4) });
            var box = new TextBox { Text = value, MinWidth = 380 };
            boxes.Add(box);
            panel.Children.Add(box);
        }
        var ok = new Button { Content = "OK", IsDefault = true, MinWidth = 90, Margin = new Thickness(0, 0, 8, 0) };
        var cancel = new Button { Content = "Abbrechen", IsCancel = true, MinWidth = 90 };
        var buttons = new StackPanel { Orientation = Orientation.Horizontal, HorizontalAlignment = HorizontalAlignment.Right, Margin = new Thickness(0, 16, 0, 0) };
        buttons.Children.Add(ok);
        buttons.Children.Add(cancel);
        panel.Children.Add(buttons);
        var w = new Window
        {
            Title = title, Content = panel, Owner = owner, SizeToContent = SizeToContent.WidthAndHeight,
            ResizeMode = ResizeMode.NoResize, WindowStartupLocation = WindowStartupLocation.CenterOwner,
        };
        ok.Click += (_, _) => w.DialogResult = true;
        w.Loaded += (_, _) => boxes.FirstOrDefault()?.Focus();
        return w.ShowDialog() == true ? boxes.Select(b => b.Text.Trim()).ToArray() : null;
    }

    /// <summary>Shows a value to copy (e.g. a new password, shown only once).</summary>
    public static void ShowSecret(Window owner, string title, string text, string secret)
    {
        var panel = new StackPanel { Margin = new Thickness(20), MaxWidth = 460 };
        panel.Children.Add(new TextBlock { Text = text, TextWrapping = TextWrapping.Wrap });
        var box = new TextBox { Text = secret, IsReadOnly = true, FontFamily = new System.Windows.Media.FontFamily("Consolas"), FontSize = 16, Margin = new Thickness(0, 12, 0, 0) };
        panel.Children.Add(box);
        var copy = new Button { Content = "Kopieren", Margin = new Thickness(0, 0, 8, 0), MinWidth = 90 };
        var close = new Button { Content = "Schließen", IsCancel = true, IsDefault = true, MinWidth = 90 };
        copy.Click += (_, _) => Clipboard.SetText(secret);
        var buttons = new StackPanel { Orientation = Orientation.Horizontal, HorizontalAlignment = HorizontalAlignment.Right, Margin = new Thickness(0, 16, 0, 0) };
        buttons.Children.Add(copy);
        buttons.Children.Add(close);
        panel.Children.Add(buttons);
        new Window
        {
            Title = title, Content = panel, Owner = owner, SizeToContent = SizeToContent.WidthAndHeight,
            ResizeMode = ResizeMode.NoResize, WindowStartupLocation = WindowStartupLocation.CenterOwner,
        }.ShowDialog();
    }
}
