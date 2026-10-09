using System;
using System.IO;
using System.Security.AccessControl;
using System.Security.Principal;

namespace Tohyee.Tray
{
    /// <summary>
    /// Decision 486: the Tohyee service runs as its own limited account,
    /// NT SERVICE\Tohyee, so it can only use folders it's been given. When a
    /// server admin chooses a folder here (a backup folder in OneDrive or
    /// Google Drive, an analytics folder), this app gives the service access
    /// to that folder. It runs as the person signed in to Windows, who owns
    /// folders in their own profile, so it can.
    /// </summary>
    internal static class FolderAccess
    {
        public const string ServiceAccount = @"NT SERVICE\Tohyee";

        /// <summary>Gives the service read (or read and write) access to the folder, making it if needed. Null when done, or why not.</summary>
        public static string Grant(string folder, bool write)
        {
            if (string.IsNullOrWhiteSpace(folder)) return null;
            try
            {
                if (write) Directory.CreateDirectory(folder);
                if (!Directory.Exists(folder)) return "The folder " + folder + " doesn't exist.";
                IdentityReference account;
                try
                {
                    account = new NTAccount(ServiceAccount).Translate(typeof(SecurityIdentifier));
                }
                catch (IdentityNotMappedException)
                {
                    // An older install where the service still runs as SYSTEM: nothing to give.
                    return null;
                }
                var info = new DirectoryInfo(folder);
                var security = info.GetAccessControl(AccessControlSections.Access);
                var rights = (write ? FileSystemRights.Modify : FileSystemRights.ReadAndExecute) | FileSystemRights.Synchronize;
                security.AddAccessRule(new FileSystemAccessRule(account, rights, InheritanceFlags.ContainerInherit | InheritanceFlags.ObjectInherit, PropagationFlags.None, AccessControlType.Allow));
                info.SetAccessControl(security);
                return null;
            }
            catch (Exception error)
            {
                return "Couldn't give Tohyee's service (" + ServiceAccount + ") access to " + folder + ": " + error.Message;
            }
        }

        /// <summary>
        /// Google Drive for desktop's own folder for this person: "My Drive" in their profile when it
        /// mirrors files (a real folder), or on its own drive letter when it streams them.
        /// </summary>
        public static GoogleDriveFolder FindGoogleDrive()
        {
            var profile = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
            foreach (var name in new[] { "My Drive", "Google Drive" })
            {
                var candidate = Path.Combine(profile, name);
                if (Directory.Exists(candidate)) return new GoogleDriveFolder { Path = candidate, Streamed = false };
            }
            foreach (var drive in DriveInfo.GetDrives())
            {
                try
                {
                    var candidate = Path.Combine(drive.RootDirectory.FullName, "My Drive");
                    if (drive.IsReady && Directory.Exists(candidate)) return new GoogleDriveFolder { Path = candidate, Streamed = true };
                }
                catch (IOException)
                {
                    // A drive that isn't ready (an empty card reader, say).
                }
                catch (UnauthorizedAccessException)
                {
                }
            }
            return null;
        }
    }

    internal sealed class GoogleDriveFolder
    {
        public string Path;
        /// <summary>A drive letter Google Drive makes for whoever is signed in; the Tohyee service may not see it.</summary>
        public bool Streamed;
    }
}
