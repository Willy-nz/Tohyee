; Tohyee for Windows: one installer with the Tohyee server, its own PostgreSQL,
; and two Windows services that start when the computer starts.
; Built by installer/windows/build.ps1 (on GitHub's Windows runners):
;   ISCC /DAppVersion=x.y.z /DSourceDir=<staging> /DOutputDir=<out> Tohyee.iss

#ifndef AppVersion
  #define AppVersion "0.0.0"
#endif
#ifndef SourceDir
  #define SourceDir "..\..\dist\windows\stage"
#endif
#ifndef OutputDir
  #define OutputDir "..\..\dist\windows"
#endif

[Setup]
AppId={{8C7C1E2B-5F0A-4B8E-9C1D-6A1F3E7B2D40}
AppName=Tohyee
AppVersion={#AppVersion}
AppVerName=Tohyee {#AppVersion}
AppPublisher=Tohyee
AppPublisherURL=https://github.com/Willy-nz/Tohyee
AppSupportURL=https://github.com/Willy-nz/Tohyee/issues
DefaultDirName={autopf}\Tohyee
DisableDirPage=yes
DefaultGroupName=Tohyee
DisableProgramGroupPage=yes
PrivilegesRequired=admin
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
MinVersion=10.0
OutputDir={#OutputDir}
OutputBaseFilename=TohyeeSetup-{#AppVersion}
Compression=lzma2/max
SolidCompression=yes
WizardStyle=modern
CloseApplications=no
UninstallDisplayName=Tohyee
UninstallDisplayIcon={app}\node\node.exe

[Tasks]
Name: "desktopicon"; Description: "Add a Tohyee shortcut to the desktop"

[InstallDelete]
; Replace the program files cleanly on updates (your data lives elsewhere).
Type: filesandordirs; Name: "{app}\app"
Type: filesandordirs; Name: "{app}\node"
Type: filesandordirs; Name: "{app}\scripts"

[Files]
Source: "{#SourceDir}\app\*"; DestDir: "{app}\app"; Flags: recursesubdirs createallsubdirs ignoreversion
Source: "{#SourceDir}\node\*"; DestDir: "{app}\node"; Flags: recursesubdirs createallsubdirs ignoreversion
Source: "{#SourceDir}\pgsql\*"; DestDir: "{app}\pgsql"; Flags: recursesubdirs createallsubdirs ignoreversion
Source: "{#SourceDir}\service\*"; DestDir: "{app}\service"; Flags: ignoreversion
Source: "{#SourceDir}\cloudflared\*"; DestDir: "{app}\cloudflared"; Flags: ignoreversion
Source: "{#SourceDir}\scripts\*"; DestDir: "{app}\scripts"; Flags: ignoreversion
Source: "{#SourceDir}\LICENSE.txt"; DestDir: "{app}"; Flags: ignoreversion
Source: "{#SourceDir}\vc_redist.x64.exe"; DestDir: "{tmp}"; Flags: deleteafterinstall

[INI]
Filename: "{group}\Open Tohyee.url"; Section: "InternetShortcut"; Key: "URL"; String: "http://localhost:3000"
Filename: "{autodesktop}\Tohyee.url"; Section: "InternetShortcut"; Key: "URL"; String: "http://localhost:3000"; Tasks: desktopicon

[Icons]
Name: "{group}\Back up Tohyee"; Filename: "{sys}\WindowsPowerShell\v1.0\powershell.exe"; Parameters: "-NoProfile -ExecutionPolicy Bypass -File ""{app}\scripts\Backup-Tohyee.ps1"""; Comment: "Back up all Tohyee data to Documents\Tohyee backups"
Name: "{group}\Tohyee logs"; Filename: "{commonappdata}\Tohyee\logs"
Name: "{group}\Uninstall Tohyee"; Filename: "{uninstallexe}"

[UninstallDelete]
Type: files; Name: "{group}\Open Tohyee.url"
Type: files; Name: "{autodesktop}\Tohyee.url"

[Run]
Filename: "{code:GetOpenUrl}"; Description: "Open Tohyee now"; Flags: postinstall shellexec nowait skipifsilent

[UninstallRun]
Filename: "{sys}\WindowsPowerShell\v1.0\powershell.exe"; Parameters: "-NoProfile -ExecutionPolicy Bypass -File ""{app}\scripts\remove-services.ps1"" -InstallDir ""{app}"""; Flags: runhidden waituntilterminated; RunOnceId: "RemoveTohyeeServices"

[Code]
var
  SetupOk: Boolean;
  FirstInstall: Boolean;
  SetupToken: String;
  TohyeeUrl: String;
  TokenEdit: TNewEdit;

function PowerShellExe(): String;
begin
  Result := ExpandConstant('{sys}\WindowsPowerShell\v1.0\powershell.exe');
end;

function GetOpenUrl(Param: String): String;
begin
  if TohyeeUrl = '' then
    Result := 'http://localhost:3000'
  else if FirstInstall then
    Result := TohyeeUrl + '/setup'
  else
    Result := TohyeeUrl;
end;

function PrepareToInstall(var NeedsRestart: Boolean): String;
var
  ResultCode: Integer;
begin
  { Stop the services so their files can be replaced on an update. }
  Exec(PowerShellExe(), '-NoProfile -Command "Stop-Service -Name Tohyee -Force -ErrorAction SilentlyContinue; Stop-Service -Name TohyeePostgres -Force -ErrorAction SilentlyContinue"',
    '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
  Result := '';
end;

procedure InitializeWizard();
begin
  TokenEdit := TNewEdit.Create(WizardForm);
  TokenEdit.Parent := WizardForm.FinishedPage;
  TokenEdit.ReadOnly := True;
  TokenEdit.Visible := False;
end;

procedure CurStepChanged(CurStep: TSetupStep);
var
  ResultCode: Integer;
  ResultFile: String;
  Lines: TArrayOfString;
begin
  if CurStep <> ssPostInstall then
    exit;

  WizardForm.StatusLabel.Caption := 'Installing the Microsoft Visual C++ runtime...';
  Exec(ExpandConstant('{tmp}\vc_redist.x64.exe'), '/install /quiet /norestart', '', SW_HIDE, ewWaitUntilTerminated, ResultCode);

  WizardForm.StatusLabel.Caption := 'Setting up the database and starting Tohyee (this can take a minute)...';
  ResultFile := ExpandConstant('{tmp}\tohyee-setup-result.txt');
  Exec(PowerShellExe(),
    '-NoProfile -ExecutionPolicy Bypass -File "' + ExpandConstant('{app}\scripts\configure-tohyee.ps1') +
    '" -InstallDir "' + ExpandConstant('{app}') + '" -ResultFile "' + ResultFile + '"',
    '', SW_HIDE, ewWaitUntilTerminated, ResultCode);

  SetupOk := (ResultCode = 0) and LoadStringsFromFile(ResultFile, Lines) and (GetArrayLength(Lines) >= 3);
  if SetupOk then
  begin
    FirstInstall := Lines[0] = 'first-install';
    SetupToken := Lines[1];
    TohyeeUrl := Lines[2];
  end
  else
    SuppressibleMsgBox('Tohyee was copied to this computer, but setting up its database and services failed.' + #13#10#13#10 +
      'The details are in ' + ExpandConstant('{commonappdata}\Tohyee\logs\setup.log') + '.' + #13#10 +
      'Run TohyeeSetup again to retry, or send that file to whoever is helping you.', mbError, MB_OK, IDOK);
end;

procedure CurPageChanged(CurPageID: Integer);
begin
  if CurPageID <> wpFinished then
    exit;
  if not SetupOk then
  begin
    WizardForm.FinishedLabel.Caption := 'Tohyee was installed, but it isn''t running yet. See ' +
      ExpandConstant('{commonappdata}\Tohyee\logs\setup.log') + ' for what went wrong.';
    exit;
  end;
  if FirstInstall then
  begin
    WizardForm.FinishedLabel.Caption := 'Tohyee is running at ' + TohyeeUrl + ' and starts by itself whenever this computer starts.' + #13#10#13#10 +
      'Next, create your admin login on the first-time setup page. It asks for this setup token (select it and press Ctrl+C to copy):';
    WizardForm.AdjustLabelHeight(WizardForm.FinishedLabel);
    TokenEdit.Text := SetupToken;
    TokenEdit.Left := WizardForm.FinishedLabel.Left;
    TokenEdit.Width := WizardForm.FinishedLabel.Width;
    TokenEdit.Top := WizardForm.FinishedLabel.Top + WizardForm.FinishedLabel.Height + ScaleY(8);
    TokenEdit.Visible := True;
    WizardForm.RunList.Top := TokenEdit.Top + TokenEdit.Height + ScaleY(16);
  end
  else
    WizardForm.FinishedLabel.Caption := 'Tohyee has been updated and is running at ' + TohyeeUrl + '. Your data and passwords were kept.';
end;

procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
begin
  if CurUninstallStep = usPostUninstall then
    SuppressibleMsgBox('Tohyee has been removed. Your data was kept in ' + ExpandConstant('{commonappdata}\Tohyee') +
      ' (the database and tohyee.env with its password). Installing Tohyee again picks it up. Delete that folder only if you no longer need the data.',
      mbInformation, MB_OK, IDOK);
end;
