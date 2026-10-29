# Proxmox VE

Tramline creates nodes on Proxmox by cloning a cloud-init template. Each VM boots, installs Docker if its image lacks it, and enrolls itself. Removing the node destroys the VM.

You need three things: a template, an API token, and a Tramline URL the VMs can reach.

## 1. A cloud-init template

Any cloud image with cloud-init works (Debian, Ubuntu, Fedora, Rocky…). On a Proxmox host, for Debian 12:

```sh
wget https://cloud.debian.org/images/cloud/bookworm/latest/debian-12-genericcloud-amd64.qcow2
qm create 9000 --name debian-12-cloud --memory 2048 --cores 2 \
  --net0 virtio,bridge=vmbr0 --scsihw virtio-scsi-pci
qm set 9000 --scsi0 local-lvm:0,import-from=$PWD/debian-12-genericcloud-amd64.qcow2
qm set 9000 --ide2 local-lvm:cloudinit --boot order=scsi0 \
  --serial0 socket --vga serial0 --ipconfig0 ip=dhcp
qm resize 9000 scsi0 +30G
qm template 9000
```

- **The network** must give the VM an address: DHCP as above, or the template's own `ipconfig0`.
- **The disk** is the size every node gets: Tramline sets CPUs and memory per node, and leaves the disk as it is.

## 2. An API token

The token needs to clone the template, configure, start, stop and delete VMs, and see the hosts. A role with just that:

```sh
pveum role add TramlineProvisioner -privs "VM.Allocate VM.Clone VM.Audit \
  VM.Config.CPU VM.Config.Memory VM.Config.Options VM.Config.HWType VM.Config.Disk \
  VM.PowerMgmt Datastore.AllocateSpace Datastore.Audit Sys.Audit SDN.Use"
pveum user add tramline@pve
pveum aclmod / -user tramline@pve -role TramlineProvisioner
pveum user token add tramline@pve tramline --privsep 0
```

To keep it away from your other VMs, grant the role on a resource pool (`/pool/tramline`), the template and the storage instead of `/`, and set the pool on the account.

Tramline tags every VM it creates `tramline`. It only ever destroys VMs with that tag, so a token with wider permissions still can't make it delete one of your own.

## 3. Connecting the account

In Tramline, open **Nodes → Compute accounts → Connect an account**, choose Proxmox VE, and fill in:

- **Proxmox URL:** e.g. `https://pve.lan:8006`.
- **API token ID and secret:** from step 2 (`tramline@pve!tramline`).
- **CA certificate:** for the default Proxmox certificates, paste the PEM contents of `/etc/pve/pve-root-ca.pem`, obtained through a trusted host connection. Use a URL whose hostname matches the server certificate. Publicly trusted certificates need no custom CA. Tramline always validates the certificate chain, validity period and hostname.
- **Certificate fingerprint:** optional extra SHA-256 pin, checked before the API token is sent. A pin alone does not trust a self-signed certificate. Find it under **System → Certificates** or with `openssl x509 -in /etc/pve/local/pve-ssl.pem -noout -fingerprint -sha256`.

- **Template VM ID:** `9000` above.
- **Storage and pool:** optional; where clones' disks go, and the pool they join.
- **Cost per host:** optional. With a monthly cost, each VM size is priced by its share of a host's memory, so Proxmox shows up in price comparisons. Leave it at 0 for hardware that's already paid for.

Then **Test connection**: it checks the token, and that the template exists and is a template.

## How a VM enrolls

Proxmox's API can't upload cloud-init user data, so Tramline points each VM at its seed instead, through the VM's SMBIOS serial (`ds=nocloud;s=<TRAMLINE_URL>/api/agent/v1/seed/<id>/`). On first boot, cloud-init fetches its user data from there and runs it. The user data installs Docker if needed, then runs the same enroll command as any other node.

- **Reaching Tramline:** the VM must reach `TRAMLINE_URL`.
- **The seed's ID** is random, and the seed works only until the VM enrolls or its join token expires (an hour), because the user data holds that token.
- **Waiting:** adding a node waits for the clone to finish, which takes a while for a full clone of a large disk.

## Sizes

Small (2 vCPU, 4 GB), Medium (4, 8 GB), Large (8, 16 GB) and X-Large (16, 32 GB). Each host only offers the sizes it can fit.

## Checking the adapter against your cluster

The adapter's tests run against a fake Proxmox API. To run the conformance suite against a real cluster, which creates, checks and destroys one small VM:

```sh
TRAMLINE_PROXMOX_URL=https://pve.lan:8006 \
TRAMLINE_PROXMOX_TOKEN_ID='tramline@pve!tramline' \
TRAMLINE_PROXMOX_TOKEN_SECRET=… \
TRAMLINE_PROXMOX_CA_CERTIFICATE="$(cat /trusted/path/pve-root-ca.pem)" \
TRAMLINE_PROXMOX_TEMPLATE=9000 \
TRAMLINE_PROXMOX_NODE=pve1 \
pnpm --filter @tramline/adapter-proxmox test
```
