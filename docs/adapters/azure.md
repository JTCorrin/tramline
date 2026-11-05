# Microsoft Azure

Tramline creates nodes as Azure VMs. Each VM boots Ubuntu, installs Docker, and enrolls itself through cloud-init. Removing the node deletes the VM, its disk, its network interface and its public address.

You need three things: a subscription, an app registration with a client secret, and a Tramline URL the VMs can reach.

## 1. The subscription

- **Free tier:** a new account's first year includes 750 hours a month of a `Standard_B1s`, enough for one small node.
- **Resource providers:** under Subscription → Resource providers, check that **Microsoft.Compute** and **Microsoft.Network** are registered. Testing the account says so if one isn't.
- **Quota:** new subscriptions have small vCPU quotas per region. Request more under Subscription → Usage + quotas if a size is refused.

## 2. An app registration

1. Under Microsoft Entra ID → App registrations, create a registration, e.g. `tramline`. It needs no redirect URI.
2. On its overview page, copy the **Application (client) ID** and the **Directory (tenant) ID**.
3. Under Certificates & secrets → Client secrets, add a secret and copy its **Value**. It is shown once; the Secret ID is not what you want.
4. Give the app a role. Under the subscription (or a resource group you made for Tramline) → Access control (IAM) → Add role assignment, give it **Contributor**.
   - On the subscription, Tramline creates its resource group itself.
   - On one resource group, Tramline uses only that group. Enter its name in the account form.

Enter the IDs and the secret under Nodes → Compute accounts → Microsoft Azure. Tramline stores the secret encrypted and never shows it again. When the secret expires, edit the account and paste a new one.

## 3. Reaching Tramline

VMs enroll over the internet, so Tramline needs an address they can reach. That can be its own public HTTPS address, or a Cloudflare tunnel set up under Nodes → Public access when Tramline runs at home.

## What Tramline creates

All of it is in one resource group (`tramline` unless you choose another), and all of it carries the tag `tramline`.

- **Per node:** a VM named after the node, plus `<name>-ip` (a static public address), `<name>-nic` and `<name>-disk`.
  - The VM runs Ubuntu 24.04 as a Trusted Launch VM (Secure Boot and vTPM).
  - It has no password. Its SSH key is generated and thrown away, so nobody can sign in; Tramline never needs SSH.
  - Its cloud-init comes in `customData`, which Azure's metadata service doesn't return, so containers on the node can't read the join token.
- **Per region:** a virtual network `tramline-<region>` and a security group `tramline-<region>`, with a rule allowing UDP 51820 for the mesh. Turn off "Open the mesh port" to leave it closed and manage the rule yourself. A group that already exists keeps its other rules.
- **Mesh:** each node's public address is known before it boots, and it offers that as its mesh endpoint, so nodes elsewhere reach it directly.
- **Edge nodes:** the security group is shared by the region's nodes, so it gets no broad rule. Turning on a node's Edge switch adds its NIC to the application security group `tramline-edge-<region>` (created the first time), and the rule `tramline-edge` in `tramline-<region>` allows TCP 80 and 443 from anywhere to members of that group only. Turning it off takes the NIC out of the group; the group and the rule stay. Caddy on the node only answers for hostnames with a public domain, and services never get host ports, so the rest of the node stays private. SSH stays closed. Contributor covers all of it.
- **Safety:** Tramline only lists, deletes and changes tagged resources, so an app with wider permissions still can't delete your other VMs. A create that fails removes what it made.

## Conformance against a real subscription

```sh
TRAMLINE_AZURE_TENANT=… TRAMLINE_AZURE_CLIENT=… TRAMLINE_AZURE_SECRET=… \
TRAMLINE_AZURE_SUBSCRIPTION=… TRAMLINE_AZURE_REGION=eastus \
  pnpm --filter @tramline/adapter-azure test
```

It creates a `Standard_B1s` in the resource group `tramline-conformance`, checks that it's listed, opens and closes its edge ports, deletes it, and checks nothing is left behind. The group, its network and its security groups stay, for the next run.
