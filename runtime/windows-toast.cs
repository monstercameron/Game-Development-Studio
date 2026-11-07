using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Runtime.InteropServices.ComTypes;
using System.Text;

// Windows requires a Start-menu shortcut with an AppUserModelID for unpackaged
// desktop notifications. Keep the registration per-user and never overwrite an
// existing shortcut whose identity is unknown.
public static class ForgeToastShortcut
{
    public const string AppId = "ForgeStudio.GameDevelopmentStudio";
    [ComImport, Guid("00021401-0000-0000-C000-000000000046")]
    private class ShellLink { }
    [ComImport, Guid("000214F9-0000-0000-C000-000000000046"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IShellLinkW
    {
        void GetPath(StringBuilder path, int size, IntPtr data, uint flags);
        void GetIDList(out IntPtr id);
        void SetIDList(IntPtr id);
        void GetDescription(StringBuilder value, int size);
        void SetDescription([MarshalAs(UnmanagedType.LPWStr)] string value);
        void GetWorkingDirectory(StringBuilder value, int size);
        void SetWorkingDirectory([MarshalAs(UnmanagedType.LPWStr)] string value);
        void GetArguments(StringBuilder value, int size);
        void SetArguments([MarshalAs(UnmanagedType.LPWStr)] string value);
        void GetHotkey(out short value);
        void SetHotkey(short value);
        void GetShowCmd(out int value);
        void SetShowCmd(int value);
        void GetIconLocation(StringBuilder value, int size, out int index);
        void SetIconLocation([MarshalAs(UnmanagedType.LPWStr)] string value, int index);
        void SetRelativePath([MarshalAs(UnmanagedType.LPWStr)] string value, uint reserved);
        void Resolve(IntPtr hwnd, uint flags);
        void SetPath([MarshalAs(UnmanagedType.LPWStr)] string value);
    }
    [StructLayout(LayoutKind.Sequential, Pack = 4)]
    private struct PropertyKey { public Guid Format; public uint Id; }
    [StructLayout(LayoutKind.Explicit)]
    private struct PropVariant { [FieldOffset(0)] public ushort Type; [FieldOffset(8)] public IntPtr Value; }
    [ComImport, Guid("886D8EEB-8CF2-4446-8D02-CDBA1DBDCF99"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IPropertyStore
    {
        void GetCount(out uint count);
        void GetAt(uint index, out PropertyKey key);
        void GetValue(ref PropertyKey key, out PropVariant value);
        void SetValue(ref PropertyKey key, ref PropVariant value);
        void Commit();
    }
    [DllImport("ole32.dll")] private static extern int PropVariantClear(ref PropVariant value);
    public static void Ensure(string shortcut, string executable, string arguments, string workingDirectory, string icon)
    {
        object instance = new ShellLink();
        try
        {
            var persist = (IPersistFile)instance;
            var key = new PropertyKey { Format = new Guid("9F4C2855-9F79-4B39-A8D0-E1D42DE1D5F3"), Id = 5 };
            if (File.Exists(shortcut))
            {
                persist.Load(shortcut, 0);
                var existingLink = (IShellLinkW)instance;
                var existingPath = new StringBuilder(2048);
                var existingArguments = new StringBuilder(4096);
                existingLink.GetPath(existingPath, existingPath.Capacity, IntPtr.Zero, 0);
                existingLink.GetArguments(existingArguments, existingArguments.Capacity);
                if (!String.Equals(existingPath.ToString(), executable, StringComparison.OrdinalIgnoreCase) || existingArguments.ToString() != arguments)
                    throw new InvalidOperationException("The notification shortcut name is already in use.");
                return;
            }
            var link = (IShellLinkW)instance;
            var properties = (IPropertyStore)instance;
            link.SetPath(executable);
            link.SetArguments(arguments);
            link.SetWorkingDirectory(workingDirectory);
            link.SetDescription("Forge Studio notifications");
            link.SetIconLocation(icon, 0);
            var value = new PropVariant { Type = 31, Value = Marshal.StringToCoTaskMemUni(AppId) };
            try { properties.SetValue(ref key, ref value); properties.Commit(); }
            finally { PropVariantClear(ref value); }
            persist.Save(shortcut, true);
        }
        finally { Marshal.FinalReleaseComObject(instance); }
    }
}
