# Private laptop access with Tailscale

Forge listens only on `127.0.0.1`. An SSH tunnel lets a laptop use the Studio at its
own `http://127.0.0.1:5173` without changing Forge's host or origin checks. Tailscale
provides the private connection between the computers; Windows OpenSSH provides the
SSH server. Tailscale SSH itself does not currently host SSH on Windows.

## Prepare the Studio desktop

1. Install Tailscale, sign in, and connect the desktop to your tailnet. Install and
   sign into Tailscale on the laptop using the same account.
2. In this repository, check existing SSH and firewall state without changing it:

   ```powershell
   powershell -NoProfile -ExecutionPolicy Bypass -File .\tools\enable-tailscale-ssh.ps1 -CheckOnly
   ```

3. If OpenSSH is not already installed, run the setup from an **administrator**
   PowerShell window:

   ```powershell
   powershell -NoProfile -ExecutionPolicy Bypass -File .\tools\enable-tailscale-ssh.ps1
   ```

   The script installs Windows OpenSSH, disables the newly created broad Windows
   firewall rule, adds an inbound SSH rule scoped to the Tailscale adapter, and
   starts the service. It refuses to replace an existing SSH service, configuration,
   or matching firewall rule. Review existing SSH setups manually instead.

4. Keep the desktop awake, connected to Tailscale, and running Forge. Find its
   Tailscale IP in the Tailscale app or with `tailscale ip -4`.

The tunnel authenticates to a Windows account and can grant access to that account,
not just Forge. Use a strong account password or SSH key, limit tailnet access to
trusted devices, and verify the host key fingerprint on the first connection. On the
desktop, inspect the fingerprint with:

```powershell
ssh-keyscan -T 5 -t ed25519 127.0.0.1 2>$null | ssh-keygen -lf -
```

Keep passwords, private keys, Tailscale auth keys, access tokens, and configuration
files containing credentials outside the repository. Do not paste them into setup
scripts, commands shared with others, issues, screenshots, or logs. The script does
not request or store them. Tailscale access and an authorized Windows account both
matter: a successful SSH login can access that account's files and shell.

## Connect from the laptop

With the laptop connected to the same tailnet, run this in a terminal, replacing the
username and address with the Windows account and desktop's Tailscale IPv4 address:

```text
ssh -N -L 127.0.0.1:5173:127.0.0.1:5173 WINDOWS_USERNAME@DESKTOP_TAILSCALE_IP
```

Confirm the SSH host fingerprint, authenticate, and keep the terminal open. Open
`http://127.0.0.1:5173` in the laptop's browser. Closing the terminal ends the
tunnel. If laptop port 5173 is occupied, use a different local port in both the
command and browser URL.

No public port forwarding, ngrok tunnel, or changes to Forge's loopback binding are
needed. This setup has to be verified from the actual laptop after both devices are
connected; a running service alone does not prove remote connectivity.

References: [Tailscale on Windows](https://tailscale.com/docs/install/windows),
[Windows OpenSSH setup](https://learn.microsoft.com/en-us/windows-server/administration/openssh/openssh_install_firstuse),
and [SSH over Tailscale](https://tailscale.com/docs/reference/ssh-over-tailscale).
